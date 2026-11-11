**Verdict: safe after the one must-fix item.** The reload itself is now low risk. The fault is in the guard: it can be killed at the moment it is needed.

Date: 2026-11-11, second pass. Scope: `native-host/reload-guarded`, the helper
and pipe, and a first run in the real Brave. The files as they are after the
tab refresh was removed (`dev-reload.js` 42 lines, `reload-guarded` 180
lines). The tab-choosing questions are dropped: no code refreshes a tab now.

Read-only review. No browser started, no reload sent, no pipe write, no signal
to Brave. Snippet tests used `sleep` stand-ins in `mktemp -d` folders.
Read-only looks at the real Brave: `ps`, `top`, `sysctl`, and the bytes of
Sekhmet's settings log.

Measured, real Brave (pid 2077, its own process group, parent launchd):
7 renderer processes at 09:10 (4 pages, 3 extension pages), 14 processes in
the group, 18 at 09:22. Main process 1,053 MB, of which 254 MB compressed.
Whole group about 2.3 GB, about 0.55 GB compressed. Swap 2,098 of 3,072 MB,
memory level 70 to 73%, 23 GB disk free. No pipe helper runs.

## Must-fix

### 1. The guard dies when the Claude session stops the command

`reload-guarded:57-62` starts the guard with `perl setsid ... &` and then
`wait`s. The guard has its own session and process group, but its parent is
still the front-end shell for the whole watch.

- Test: front end pid 15871, guard pid 15873, `ppid=15871 pgid=15873`.
  `pgrep -P 15871` lists the guard. After `kill -KILL` of the front end the
  guard lives on with `ppid=1`. So the guard survives a session that *dies*.
- It does not survive a session that *stops the command*. Claude Code 2.1.322
  (the installed binary) kills the command's process group and then every
  recorded descendant by pid:
  `A0(e,n,r){let s=await YE(e,!1) ... process.kill(-e,n) ... for(let[y,b]of s){ ... process.kill(y,n)`.
  A descendant in another session is still a descendant.

Failure scenario: memory runs away, the machine slows, the Bash tool call hits
its timeout (default 120 s; a clean run takes up to 76 s) or the user presses
Esc. Claude Code sends SIGKILL to the guard. Nothing quits Brave. This is
incident 3 again.

Fix (either):
- Code: double fork, so the guard never has the front end as parent. Tested
  form: `perl -MPOSIX -e 'fork and exit 0; POSIX::setsid() != -1 or die "setsid: $!"; exec @ARGV or die "exec: $!"' /bin/bash "$HERE/reload-guarded" --guard "$@" </dev/null >>"$LOG" 2>&1`
  (result: `ppid=1`, own pgid). The front end can no longer `wait`. It follows
  the log until a line `reload-guarded: exit N`, with a deadline of
  `WATCH_S + 60` s, and exits with N. Every exit path must print that line.
  The refusals at lines 109-126 do not print it today, and neither does a
  death by error. One `trap 'say "exit $?"' EXIT`, set at line 70 and kept
  when the trap at line 137 is set, covers all paths. Run it with a tool
  timeout of 180 s.
- No code: the user runs the command in their own terminal, not through a
  Claude session. Ctrl-C and a closed terminal are covered (`trap '' HUP INT`,
  own session).

## Should-fix

- **S1. `setsid` result is not checked** (`reload-guarded:57`). Test: when
  the caller is a group leader, `POSIX::setsid()` returns -1 and the guard
  runs on in the old session, silently. Fix: `!= -1 or die` (in the form above).
- **S2. A non-numeric value ends the guard without a trip.** Test, bash 3.2:
  `fp="12x"; [ $(( fp - FP0 )) -gt 3 ]` ends the script with status 1. Not
  reachable with the defaults (all figures come from `int()` in awk or from
  `cut`). Reachable through the environment: `RELOAD_WATCH_S=1m` ends the
  loop at once, after the reload is sent. A non-numeric threshold makes its
  check always false (`[ 5 -gt abc ]`). Fix: at the start, refuse any setting
  that matches `''|*[!0-9]*`; in the loop, replace a non-numeric `fp` with `$FP0`.
- **S3. `ps` and `pgrep -f` read the arguments of every process, each tick,
  with no timeout** (`reload-guarded:92,166`). That read can wait on swapped
  pages. A stall delays the next swap check. Fix:
  `ps -o rss=,command= -g "$PGID"` (tested read-only: same figures, 5 ms
  against 33 ms) and `pgrep -g "$PGID" -f ...` inside the loop. Native hosts
  are in Brave's group (seen: another host, pgid 2077). Keep the
  whole-machine `pgrep -f` for the count check at line 110.
- **S4. `read ... <<<` makes a temp file in bash 3.2** (lines 123, 157). On a
  full disk the `read` does not run and `rss`/`tabs` keep old values. Fix:
  `set -- $(rss_and_tabs); rss=${1:-0}; tabs=${2:-0}`.
- **S5. The log is emptied at each start** (`reload-guarded:56`). A second
  run erases the report of a run that quit Brave. Fix: a file per run with the
  time in its name. Two runs at once are not prevented either.
- **S6. `quit_brave` does not look again at what pid `$MAIN` is.** Pid reuse
  inside 60 s is not realistic on macOS. A one-line recheck of
  `ps -o command= -p "$MAIN"` against `$BRAVE_BIN` removes the question.
- **S7. A false trip costs a restart of a 1,931-tab Brave.** For the run, the
  user does not open tabs in Brave during the 60 s: each page load adds 1 to 3
  renderer processes toward the limit of 20. A click on the new "reload this
  tab" toast is fine; it keeps the tab's process.

## Question 3: reload-guarded

- **(a) Wrong target.** None found. `MAIN` comes from the helper's parent
  chain and must start with the Brave path (line 82). `PGID` must equal `MAIN`
  (line 115); an empty `PGID` fails that test and the guard refuses. So
  `kill -KILL -"$PGID"` can only name a group whose leader is that Brave. The
  form works in bash 3.2 (tested on a stand-in group: all 3 members gone).
  The group holds Brave's native hosts and their children too (seen: the
  browser-tab-tree host; also a running download). They die with it. No unset
  variable under `set -u`; `"$@"` with no arguments is fine in bash 3.2
  (tested). Pid reuse: see S6.
- **(b) Survival.** A dead starter: yes (tested). A starter that is stopped
  by Claude Code: no. See must-fix 1. HUP and INT are ignored; the guard has
  no terminal.
- **(c) Stalls and order.** The order is right: `kill -0`, swap, level, then
  `ps`, then the footprint figure from the file. Swap and level need no
  process scan. `footprint` cannot stall the loop. `ps` and `pgrep -f` can
  (S3). No step has a timeout.
- **(d) Thresholds.** A reload with no tab refresh should move the renderer
  count by 1 and add little memory. The limits leave wide room: 20 new
  renderer processes, +2,048 MB footprint, +3,000 MB resident, +1,024 MB swap,
  level under 20%.
  - Resident memory can rise without real growth when compressed pages come
    back. The whole group has about 0.55 GB compressed, so that cannot reach
    3,000 MB.
  - Normal use moved the group from 14 to 18 processes in 12 minutes. That is
    far from 20 in one minute.
  - Swap and level are machine-wide. Another app could trip them; at level 70%
    that is unlikely.
  - For a real runaway, the Brave checks trip first (harness: 7 new processes
    seen within 1 s). Level 70% to 20% is about 8 GB, so swap and level are
    late backstops.
- **(e) bash 3.2 and bad values.** `bash -n` passes. `for _ in`,
  `local p="$1" cmd` and `sleep 0.5` work. Empty `swap`, `rss` or `tabs` gives
  no trip and no exit. Empty `lvl` prints an error and gives no trip. Empty
  `LVL0` refuses to start. Non-numeric values: S2. Here-strings: S4.
- **(f) Brave quits, or the helper stays away.** Brave gone: the next tick
  prints "Brave exited on its own", exit 3. No new helper: the watch runs the
  full 60 s, prints WARNING, exit 1, and leaves Brave alone. The watch ends at
  60 s even if a figure still rises.
- **`footprint`.** The parse works for one pid, many pids, and a dead pid in
  the list (tested on `sleep`). The manual names no suspension of the target.
  If no figure comes in 10 s, that check is off and the run goes on.

## Question 2: helper and pipe

- **Delivered twice: no.** One line reaches one reader, once. Test with two
  readers on one pipe: A got the line, B got end-of-file.
- **Two browsers.** The line goes to either one. `reload-guarded:110` refuses
  when two helpers run. Plain `reload-extension` does not check. The test
  harness refuses to send when a helper already runs (`drive.mjs:65`).
- **Several lines.** Lines that arrive together reach the old background page
  as separate messages; the first `runtime.reload()` ends that page. One
  reload. Lines seconds apart give one reload each. Nothing multiplies them.
- **Repeated reloads: no.** Only a pipe line causes a reload, and the only
  writer is `reload-extension`. No hook, `cmds.rb` or VCS hook calls it.
  `dev-reload.js` connects once and does not retry (lines 25-37).
- **Any line means "reload".** A line that does not parse still sends
  `{"reload": true, "files": []}` (`dev_reload_host.py:44-47`). With no tab
  refresh this costs one reload, no more.
- A writer with no reader fails at once (`ENXIO`, tested). The helper exits at
  end-of-file on stdin. The helper regex matches the python process and not
  the `.sh` wrapper or an editor (tested on sample command lines). The wrapper
  chain is `exec` all the way, so the pid is stable.

## Question 4: a first run in the real Brave, no tab refresh

- **What the reload does.** `dev-reload.js:30` calls `runtime.reload()`, as
  the Reload button does. The new page removes the old stored key and starts
  a new helper. Nothing else. `tabs.reload` appears in no file now.
- **Loaded tabs.** Each loaded tab with `lib.js` shows a toast
  (`lib.js:406-454`). Only a click reloads, and only that tab
  (`lib.js:419`). The port retry cannot spin: it reconnects only if the port
  was open over 5 s. A sleeping tab runs no script and loads nothing. It
  starts working one reload after `lib.js` is first loaded, as its comment
  says.
- **No leftover refresh list.** The last two records for
  `sekhmet_devReloadTabs` in the settings log
  (`Local Extension Settings/encfojbdpiekkdacafhoonbcjaggcpcp/000029.log`) are
  a PUT of 14,235 bytes (about 1,290 ids) and then a DELETE. Nothing reads the
  key now in any case. The PUT is also direct evidence for the cause.
- **Not yet shown.** `runtime.reload()` has never run in the real Brave
  without the mass refresh. The evidence that it is harmless is the daily use
  of the Reload button, the harness runs, and the record above. The first run
  is the test, which is why must-fix 1 matters.
- **If the guard trips.** SIGTERM, then SIGKILL to the group after 5 s. With
  1,931 tabs a clean quit may take longer than 5 s; then the next start shows
  the restore prompt, as after the force-quits.
- **Before the run.** `dev-reload.js` goes into the manifest as
  `["polyfill.js", "background.js", "dev-reload.js"]`, then one hand reload.
  The project `CLAUDE.md` asks for the user's yes first.
- **`--no-refresh` is gone.** `reload-guarded --no-refresh` now sends a file
  named `--no-refresh`, which is only logged. Harmless. The handoff plan still
  names the old command.
- `bash -n`, `node --check` (`dev-reload.js`, `lib.js`) and a parse of both
  Python files pass.

## Fixed after this review (2026-11-11)

- Must-fix 1: the guard is forked twice (`perl ... fork and exit 0; setsid() != -1 or die`), so its parent is launchd. The starter follows the log until `reload-guarded: exit N` (deadline `WATCH_S + 60` s, then exit 4). One EXIT trap writes that line on every path. Test `guarded-orphan` in a throwaway Brave: the starter's group and each of its processes were SIGKILLed 3 s in; the guard still tripped on footprint (+1,006 MB) and quit that Brave.
- S1 (setsid checked), S2 (settings must be whole numbers; every figure falls back to its last value if not numeric), S3 (`ps -g`, `pgrep -g` in the loop), S4 (no here-strings), S5 (a new log per run under `~/.local/share/sekhmet/reload-guarded/`), S6 (before the kill, Brave's start time must match the one read at the start; the command line was not reliable: in one test run `ps -o command=` did not show the Brave path for a live Brave).
- S7 stays an instruction: do not open tabs in Brave during the 60 s watch.
