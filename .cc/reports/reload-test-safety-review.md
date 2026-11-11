# Safety review: `.cc/scripts/reload-test/` (guard.sh, drive.mjs, mini-ext)

Date: 2026-11-10. Reviewer did not run guard.sh, drive.mjs or any browser.
Checks made: `bash -n`-level reading, the pid-collection awk and the parsers on
synthetic input and the live process list, `set -m` / group-kill / trap
behaviour with `sleep` stand-ins under `/bin/bash` 3.2.57, and the current
memory, swap and disk state.

**Verdict: not safe to run as written. Safe to run after M1-M3.** S1-S4 are
cheap and close the remaining leak paths; do them in the same pass.

## Machine state at review time

| Item | Value |
|---|---|
| Hardware | Apple M1, 16 GB, page size 16384 (matches `hw.pagesize`) |
| `kern.memorystatus_level` | 55 (preflight passes) |
| Swap | `total = 0.00M used = 0.00M` (no swap file yet) |
| Compressor | occupied about 4.8 GiB, stored about 11 GiB (already heavy) |
| Free disk (Data volume, shared with swap) | **7.4 GiB of 228 GiB (97 % full)** |
| Real Brave | running (main pid 72952, 17 helpers, all in pgid 72952) |
| `/bin/bash` | 3.2.57 |

The low free disk matters: swap files come out of the same APFS container. A
runaway that the guard misses would fill the disk in seconds to minutes.

---

## Must-fix before running

### M1. An empty `PROFILE` makes cleanup SIGKILL every process you own

Failure: `mktemp -d` fails (disk full is plausible at 97 %, or `TMPDIR` is
unwritable). The script has no `set -e`, so `PROFILE=""` and it continues.
Every exit path, including the preflight `exit 2`, runs `cleanup`:

- `brave_pids` uses `index(line[i], prof)` with `prof=""`. macOS awk returns 1
  for an empty needle, so **every** process matches. Verified:
  `echo x | awk '{print index($0,"")}'` prints `1`, and the synthetic test
  selected the unrelated pid too.
- The leftover check `ps ... | grep -F "" | grep -v grep` also matches every
  line, then `xargs kill -KILL` runs on all of them.

Result: SIGKILL to every process of your user, including Finder, the Dock, your
real Brave, your terminal and Claude Code. In effect, a forced logout.

Fix: make one validated temp root, and abort **before** the trap is installed.

```bash
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/sekhmet-reload-test.XXXXXX")" || { echo "GUARD: mktemp failed"; exit 2; }
ROOT="$(cd "$ROOT" && pwd -P)" || exit 2          # canonical: /private/var/folders/..., no "//"
TOKEN="${ROOT##*/}"
case "$TOKEN" in sekhmet-reload-test.??????) ;; *) echo "GUARD: bad temp dir '$ROOT'"; exit 2 ;; esac
PROFILE="$ROOT/profile"; mkdir "$PROFILE" || exit 2
```

Then use `$TOKEN` (not the full path) for every name match, refuse to match when
it is empty, and in cleanup delete with
`case "$ROOT" in */sekhmet-reload-test.??????) rm -rf "$ROOT" ;; esac`.

### M2. Nothing kills Brave if guard.sh dies without running its trap

Failure scenarios, all realistic:

- guard.sh gets SIGKILL: `kill -9`, Activity Monitor "Force Quit", or a tool
  timeout that kills only the top process.
- guard.sh is suspended with Ctrl-Z. Brave is in its own process group, so it
  is **not** stopped and keeps running with no guard. The driver is stopped.
- guard.sh blocks in a child (`ps`, `lsof`) under heavy memory pressure. Bash
  runs a trap only after the foreground child returns.

How bad: Brave keeps running headless with no limit. Idle, that is a few hundred
MB. If a reload runaway is in progress, it is the original incident (10-20 GB of
swap), and with 7.4 GiB of free disk it can fill the disk.

Cheap fix, verified with `sleep` stand-ins (guard SIGKILL: the stand-in died
within 2 s; guard alive past the hard deadline: the stand-in died on time): a
watchdog in its own process group with an absolute deadline. Start it right
after `BRAVE_PID=$!`, still inside the `set -m` block.

```bash
GUARD_PID=$$
HARD_DEADLINE_S=120          # > DEADLINE_S + cleanup time
( trap '' INT TERM HUP
  end=$(( $(date +%s) + HARD_DEADLINE_S ))
  while kill -0 "$GUARD_PID" 2>/dev/null && [ "$(date +%s)" -lt "$end" ]; do sleep 1; done
  kill -KILL -"$BRAVE_PID" 2>/dev/null
  pkill -KILL -f "^/Applications/Brave Browser\.app/.*$TOKEN" 2>/dev/null
) </dev/null >/dev/null 2>&1 &
WATCHDOG_PID=$!
```

At the end of `cleanup`, add `kill -KILL -"$WATCHDOG_PID" 2>/dev/null`. The
watchdog's own command line does not contain `$TOKEN`, and `pkill` skips itself.

Also: when Claude runs a scenario through its Bash tool, give it
`timeout: 300000` (or run it in the background). One scenario takes 45-80 s;
the default 120 s is too close.

### M3. No trip on system memory pressure; the compressor metric can miss a leak

`Pages occupied by compressor` is the RAM the compressor uses. It is not the
memory that was compressed. Right now the ratio is about 2.3:1. A leak of
repeated or zero-filled data compresses 5-10:1. Brave can then hold 5+ GB of
logical memory while RSS stays small (pages are compressed) and occupied grows
under 1024 MB. Swap stays 0 until the compressor pool is full. The machine
stutters (other apps' pages also get compressed) before any trip fires. This is
the "looked small by RSS while using GBs" case.

Fix: add two cheap trips to the loop. Each is one `sysctl` call or reuses the
`vm_stat` call that is already made.

```bash
MIN_LEVEL_DURING=20          # kern.memorystatus_level floor while running
MAX_STORED_GROWTH_MB=2048    # logical memory pushed into the compressor
PAGESIZE=$(sysctl -n hw.pagesize)        # once, outside the loop
comp_mb() {   # prints "<stored_mb> <occupied_mb>"
    vm_stat | awk -v ps="$PAGESIZE" '/stored in compressor/ {s=$NF} /occupied by compressor/ {o=$NF}
        END { gsub(/\./, "", s); gsub(/\./, "", o); print int(s*ps/1048576), int(o*ps/1048576) }'
}
# in the loop:
lvl=$(sysctl -n kern.memorystatus_level)
read stored occ <<< "$(comp_mb)"
...
elif [ "$lvl" -lt "$MIN_LEVEL_DURING" ]; then reason="TRIPPED: memory level ${lvl}%"; break
elif [ $(( stored - STORED0 )) -gt "$MAX_STORED_GROWTH_MB" ]; then reason="TRIPPED: compressor stored grew"; break
```

This parse was tested here and printed `stored=11479 occ=5064`. Keep the swap
trip and the occupied trip as they are. Log `lvl` and the stored growth in the
CSV too. A false trip caused by your other apps is safe; it only makes that run
inconclusive.

---

## Should-fix

### S1. On a trip, Brave keeps running while the script prints its report

After `break`, the script runs `echo` and `cat` of the driver log before
`exit 3` fires the EXIT trap. The gap is milliseconds, but the kill should
come first. Fix: call `cleanup` on the line right after `done`, then report.

### S2. A signal runs cleanup, then the script carries on and reports success

Verified: with `trap cleanup ... TERM`, a SIGTERM ran cleanup, then the script
went on and printed "driver finished" with exit 0. Also, `cleanup` begins with
`trap - ... INT ...`, so a second Ctrl-C during its `sleep 1` kills guard.sh
before the leftover check and before the temp folder is removed. (The main
kills have already run by then, so this is not a leak by itself.)

Fix:

```bash
cleanup() {
    trap '' INT TERM HUP      # ignore further signals; never stop half way
    trap - EXIT
    ...
}
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP
trap cleanup EXIT
```

### S3. Name matching is too broad, and the full-path match can miss Brave's own children

Shown on the live process list: the awk matched **itself** (its `-v prof=...`
argument contains the path). It also matched this review's tool shell, whose
command line contained the path, and then took **all that shell's children** by
the ppid walk. In a real run, any process that names the temp path is killed
together with its descendants. Examples: a `tail -f` on a file in the profile,
or a Claude Bash call that mentions the path.

The match also uses the literal `$TMPDIR/...` string. `TMPDIR` ends in `/`, so
the string has `//`, and it lacks the `/private` prefix. Any child that
Chromium gives a canonical path (crashpad's `--database=` is the likely one) is
missed.

Facts from your real Brave: renderers do **not** carry `--user-data-dir`. All
helpers stay in the main pid's process group. `chrome_crashpad_handler` has
ppid 1 and its **own** process group (72995, not 72952). So pgid catches the
helpers, and only the name match can catch crashpad.

Fix (tested on synthetic input: it picks the test tree and the token-named
crashpad; it skips the real Brave tree, a `tail` naming the path, the awk
itself, and everything when the token is empty):

```bash
brave_pids() {
    [ -n "$BRAVE_PID" ] && [ -n "$TOKEN" ] || return 0
    ps -axo pid=,ppid=,pgid=,command= | TOKEN="$TOKEN" BUNDLE="/Applications/Brave Browser.app/" awk -v root="$BRAVE_PID" '
        { pid[NR]=$1; ppid[NR]=$2; pgid[NR]=$3; line[NR]=$0
          cmd=$0; sub(/^ *[0-9]+ +[0-9]+ +[0-9]+ /, "", cmd); brave[NR]=(index(cmd, ENVIRON["BUNDLE"])==1) }
        END {
            if (ENVIRON["TOKEN"] == "") exit 1
            for (i=1; i<=NR; i++) if (brave[i] && (pid[i]==root || pgid[i]==root || index(line[i], ENVIRON["TOKEN"]))) mine[pid[i]]=1
            changed=1
            while (changed) { changed=0
                for (i=1; i<=NR; i++) if (brave[i] && !(pid[i] in mine) && (ppid[i] in mine)) { mine[pid[i]]=1; changed=1 } }
            for (p in mine) print p
        }'
}
```

Passing the token through `ENVIRON` keeps it out of awk's argv. Requiring the
Brave bundle path means a pid is killed only if it is a Brave executable. That
also covers the (very unlikely) case where Brave's pid is reused. In cleanup,
replace the `grep -F "$PROFILE" | grep -v grep | xargs kill` leftover check with
`pgrep -g "$BRAVE_PID"` plus `pgrep -f "^/Applications/Brave Browser\.app/.*$TOKEN"`.
`pgrep -g` was checked on this machine.

Launch Brave with the bundle path directly, or through `nice`, which execs it so
the pid stays a Brave executable. Do not wrap it in `timeout`; then the root pid
is not a Brave executable.

### S4. The temp copy of the repo leaks on two paths (the same pattern as the earlier Brave leak)

- `drive.mjs` calls `process.exit(1)` inside the `try` (lines 45 and 60). That
  skips the `finally`, so `$TMPDIR/sekhmet-copy-*` stays behind. This is the
  exact bug that once leaked Brave. It is harmless here only because the driver
  no longer owns Brave.
- On a deadline, a trip, or Ctrl-C, guard.sh SIGKILLs the driver, so the
  `finally` never runs.

Each copy is about 1 MB, so this is disk clutter, not danger. Fix both at once:
let guard.sh make the copy (`$ROOT/ext`) before Brave starts, and delete it with
`$ROOT` in cleanup. Pass the path to the driver as an argument. In the driver,
replace each `process.exit(1)` inside `try` with `throw new Error(...)`. Keep
the copy filter as it is. If the driver keeps making the copy, at least throw
instead of exiting.

### S5. Validity: turn on developer mode, or the reload test may show nothing

The earlier run left the extension `DISABLED` with `unsupportedDeveloperExtension`
after the reload. The retro also notes that "content scripts stopped running
entirely" after `runtime.reload()` in headless Brave. The most likely cause:
recent Chromium disables unpacked (and command-line) extensions when they are
(re)installed while the profile's **developer mode is off**. A fresh profile has
it off. Your real Brave has it on, because you use "Load unpacked". So the test
reload takes a different path from the one that ran away. A clean result could
then mean only "the extension was disabled", not "the reload is safe".

Fix in `drive.mjs`: open `chrome://extensions` **before** the load, then:

```js
await page.evaluate(`chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}).then(() => 'ok', e => String(e))`);
console.log('dev mode:', await page.evaluate(`chrome.developerPrivate.getProfileConfiguration().then(c => c.inDeveloperMode)`));
```

Then confirm that `before reload:` prints `ENABLED` with no reasons.
(Alternative: write `{"extensions":{"ui":{"developer_mode":true}}}` to
`$PROFILE/Default/Preferences` before launch.)

**Safety consequence:** with developer mode on, the reload is more likely to
reproduce the runaway, including any reload loop that the disabled state used
to stop. So do M1-M3 first. The guard will now be tested for real.

Loading method: keep CDP `Extensions.loadUnpacked`. It gives the same install
location as your real "Load unpacked" (UNPACKED). Chromium's CDP docs say it
needs `--enable-unsafe-extension-debugging` and **`--remote-debugging-pipe`**,
but the earlier run loaded the extension over the port in Brave 157. So it works
here, and the driver already logs `loaded.error` if it ever stops working. Brave
157 also honours `--load-extension` (`.cc/scripts/cdp.js` uses it). That gives
location COMMAND_LINE, which is less faithful, and the same developer-mode check
applies to it. It is not better.

### S6. Flags that keep the test browser away from your real setup, plus a leftover report

Add to the Brave command line:

- `--use-mock-keychain`: new headless Brave otherwise reads your login
  keychain's "Brave Safe Storage" item.
- `--disable-background-networking --disable-component-update --no-default-browser-check`:
  a fresh Brave profile downloads ad-block and other components. That adds
  network traffic and a memory bump of 100+ MB to the baseline.
- `--disable-brave-update`: brave-core's switch to stop the updater from
  checking. I believe this is the switch's name; an unknown switch is ignored.
- `</dev/null` on the Brave line. With `set -m`, bash does not redirect a
  background job's stdin, so Brave inherits the terminal. If Brave reads it, it
  stops on SIGTTIN. That is a hang, not a leak, but it is avoidable.

It is unknown whether `--disable-crash-reporter --disable-breakpad` stop crashpad
on macOS, and whether the test's crashpad `--database` follows `--user-data-dir`.
If neither holds, a test crashpad handler is a process with ppid 1, its own
process group, and no token in its command line. No match can see it. It
normally exits when its client dies, but make that visible. Take
`PRE=$(pgrep -f '^/Applications/Brave Browser\.app/' | sort)` before launch. At
the end, print `comm -13 <(echo "$PRE") <(pgrep -f '^/Applications/Brave Browser\.app/' | sort)`
as "new Brave processes still alive". Report them only; do not kill them,
because you might start your real Brave during the run. Bash 3.2 supports
`<(...)`.

### S7. Make the guard react faster and keep it ahead of Brave for CPU

Measured: one tick of the current checks (two `ps`, awk, `sysctl`, `vm_stat`)
takes about 145 ms with 657 processes. That is cheap enough for
`sleep 0.5`, and macOS `/bin/sleep` takes fractions. Also start Brave with
`nice -n 10 "$BRAVE" ...`. Helpers inherit the nice value, so under pressure
the guard's forks get CPU first. This was verified with a stand-in: nice 10,
same pid, own process group. It slows Brave a little; it does not change what a
reload does.

How fast can a runaway grow in one tick? A tight loop that faults in fresh
anonymous memory on an M1 does about 1-3 GB/s. Swap writes at about 1-2 GB/s.
A leak driven by reloads (new background pages, renderers) is more like 0.1-1
GB/s. With a 1.15 s effective tick, the worst-case overshoot past a threshold
is about 1-3 GB. With a 0.65 s tick it is about half that. There is about 8.8
GB of headroom (55 % of 16 GB), so either one is survivable. The 0.5 s tick
still matters for disk: it keeps the worst-case swap overshoot well under the
7.4 GiB of free disk.

### S8. Preflight on free disk

Add the check below. The current 7.4 GiB passes, but less than that means a
missed trip could fill the disk.

```bash
free_gb=$(df -g /System/Volumes/Data | awk 'NR==2 {print $4}')
[ "$free_gb" -ge 5 ] || { echo "GUARD: only ${free_gb} GB disk free, not starting"; exit 2; }
```

---

## Notes (checked, no change needed)

- **Parsers are correct.** `vm.swapusage` always reports in `M`. The sed gave
  `0` for the live line and `2101` for a synthetic `used = 2101.75M`.
  `vm_stat`'s trailing period is stripped correctly. `hw.pagesize` = 16384 =
  `vm_stat`'s own header. Bash 3.2 arithmetic is 64-bit. If any parse ever
  returns a word, `set -u` or the arithmetic error stops the script, and the
  EXIT trap kills Brave. That is the safe direction.
- **`set -m` works in a non-interactive bash 3.2 script.** Verified: the
  background job gets its own pgid (= its pid). The later job started after
  `set +m` stays in the script's group. `kill -KILL -PGID` killed the group
  (rc 0). A non-existent group returns rc 1 and does nothing. The script uses no
  arrays, so there is no empty-array `set -u` trap. The `local` variables in
  `cleanup` are fine. A "Killed: 9" job notice prints on stderr; it is cosmetic.
- **Ctrl-C:** it goes to guard.sh's foreground group. The driver ignores SIGINT
  (bash sets that for background jobs without job control), and Brave is in
  another group. Both die in cleanup. The cleanup itself is correct; see S2 for
  the exit status.
- **Every hang in the driver is covered.** No `await` in drive.mjs has a timeout
  (`connect`, `send`, `evaluate`, `fetch`). The `/json/version` wait gives up
  after about 10 s and then throws. A normal run takes about 45 s. Any hang ends
  at `DEADLINE_S=75` because the guard loop does not depend on the driver. With
  M2, a hang in guard.sh itself ends at the 120 s hard deadline.
- **Paths cannot reach the repo or your home.** The copy source resolves to the
  repo root `/Users/anthony/projects/sekhmet`. None of its parent folders match
  the filter. The destination is `mkdtempSync` under `os.tmpdir()`.
  `rmSync(copy)` runs only on that fresh folder. `rmSync` does not follow
  symlinks: `.claude/skills/{cmds,fish}` are symlinks into `~/dotfiles`, and
  they are copied and removed as links. Node refuses to copy a folder into
  itself, so even a strange `TMPDIR` cannot make a recursive copy. The copy is
  about 1 MB (`.cc` holds 49 of the repo's 52 MB, and it is excluded).
  `mini-self` loads `mini-ext/` from the repo in place. Chromium does not write
  into an unpacked extension folder, so this is fine; copying it into `$ROOT`
  would make it symmetric.
- **Same extension ID as your real Sekhmet.** The manifest has a `key`, so the
  copy gets the real ID, in a separate profile. It asks for `nativeMessaging`,
  but only `dev-reload.js` calls `connectNative`, and that file is not in the
  manifest. So no native host starts.
- **Your running real Brave is never matched.** Its pids are in pgid 72952 with
  parent launchd. They contain no token, and the test's ppid walk starts at the
  test pid. With M1 and S3 this holds even with an empty token.
- **RSS is a rough number.** Summing RSS over helpers counts the shared Brave
  framework once per process, and it leaves out compressed or swapped pages.
  1500 MB may false-trip if a fresh profile plus the reload sits near 1 GB.
  A false trip is safe. If that happens, record a baseline after the load and
  trip on growth from it. `footprint -p <pid> -t` gives the real per-process
  footprint (89 ms for a small process). It is good for a log line every few
  seconds, but too slow per tick for a big browser.
- **The `kern.memorystatus_level >= 25` preflight is meaningful.** It is the
  kernel's percentage of memory it can still give out. It is the same signal
  that drives Activity Monitor's pressure graph. 25 % of 16 GB is about 4 GB.
  It is more useful as the in-run floor in M3 than as a one-time check.
- **Between scenarios,** check that `pgrep -f sekhmet-reload-test` prints
  nothing before you start the next one.
