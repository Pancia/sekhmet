# Critique of two retro suggestions (2026-11-11)

Read-only review. No file was edited except this report. No browser was started.
Stand-in tests used `sleep` in a fresh `mktemp -d` folder
(`/var/folders/bs/96z5js2n1qb_gcc0q54ph6f00000gn/T/tmp.QZP9tTEpdw/sim.py`).

## Suggestion 1: sleeping tabs (project CLAUDE.md)

Verdict: **changed**.

### Claims checked

| Claim | Result | Evidence |
|---|---|---|
| Reloading a sleeping tab loads it | True | `.cc/reports/reload-test-results.md`, throwaway Brave: old code woke 4 of 4 discarded tabs |
| `executeScript` on a sleeping tab loads it (implied) | **False**. It fails. | Chromium `extensions/browser/script_executor.cc`: a frame with `!IsRenderFrameLive()` gets the error `"Frame with ID %d is not ready"` and is skipped. No navigation. |
| `sendMessage` on a sleeping tab loads it (implied) | **False**. It fails. | Chromium `extension_message_port.cc` `RegisterFrame`: `if (!render_frame_host->IsRenderFrameLive()) return;`. No frame, so "Receiving end does not exist". Nothing in the file navigates. |
| `tab.discarded \|\| tab.status === 'unloaded'` covers both kinds | True; `status` alone is enough | Chromium `ExtensionTabUtil::GetLoadingStatus`: `if (!HasValidMainFrameProcess(contents) \|\| contents->WasDiscarded()) return kUnloaded`. So a discarded tab and a restored, never-loaded tab both report `unloaded`. Keeping `tab.discarded` too costs nothing and guards against a Brave patch. |

Other calls that do load a sleeping tab, and that the suggestion does not name:
`tabs.update` with `url` (or `active: true`), `tabs.goBack`/`goForward`,
`tabs.duplicate`, and activating a tab.

### Current code

No code in the repo acts on many tabs. Every tab call (committed and the
uncommitted changes from other sessions) acts on one tab:

- `background.js:54-55` `executeScript`: the right-clicked tab only.
- `background.js:63` `tabs.query({currentWindow, active})`: the active tab.
- `background.js:70,104` `sendMessage`: the active tab.
- `background.js:186` `tabs.update(sender.tab.id, {url})`: the tab that sent the
  message, so it is loaded. Unreachable anyway (openfront-block.js is out of the
  manifest).
- `openfront-blocked.js:10-11`: the page's own tab.
- `dev-reload.js:30` `runtime.reload()`: no tab call. `tabs.reload` appears nowhere.

### Overlap with what is already there

The committed CLAUDE.md (commit 0908825) already says "Reload Sekhmet no other
way: ... nothing that refreshes tabs ... Ask before you add code that reloads a
tab without a click". That bans the original bug outright, which is stronger than
"skip sleeping tabs and cap". Suggestion 1 adds value only as the general fact
(most tabs are asleep) applied to other bulk tab code. It should not repeat the
reload ban.

### Would it have stopped the original bug?

Yes. The old code was `tabs.query` then `tabs.reload` on every match, which is the
case the suggestion names. But the false part (executeScript/sendMessage load a
tab) teaches a wrong model. A reader who learns that sendMessage fails on a
sleeping tab may then "fix" it by reloading the tab first.

### Staleness

"About 1,900 tabs" will drift. Date it, and give a floor that stays true longer.

### Revised text

> - The user's Brave has well over 1,000 tabs open (1,931 on 2026-11-11), and
>   nearly all are asleep: restored but never loaded, or discarded. Code that runs
>   over many tabs must skip sleeping ones (`tab.discarded || tab.status ===
>   'unloaded'`) and cap how many it touches. Reloading, navigating, activating or
>   duplicating a sleeping tab loads it. `executeScript` and `sendMessage` do not
>   load it; they fail ("Frame with ID 0 is not ready", "Receiving end does not
>   exist"), so catch the error.

Smaller and stronger option (not done; read-only): a line in `test/check.js` that
fails if `tabs.reload` appears in any extension script. It enforces the existing
ban without anyone reading CLAUDE.md.

## Suggestion 3: detaching a process from a Bash call (global CLAUDE.md)

Verdict: **changed**.

### Where to edit

`~/.claude/CLAUDE.md` is a hard link (2 links, same inode) to
`~/dotfiles/rcs/claude-user-claude.md` (MANIFEST line 9). Edit that file.
The section is "Background processes: `service` vs `svc`" at line 300.

### Claude Code 2.1.322 kill behaviour (read from the binary)

Binary: `~/.local/share/claude/versions/2.1.322` (Bun, arm64). Relevant minified
code:

- `IE(pid, sig)` calls `A0`. `A0` first calls `YE(pid)`, which runs
  `ps -A -o pid= -o ppid= -o pgid=` **at kill time** and walks the tree by
  parent pid from the call's shell. Then `process.kill(-pid, sig)` (the group),
  then `process.kill(y, sig)` for each descendant found (skipping members of the
  same group when the group kill worked and the signal is not SIGKILL).
- The Bash call's stop path (`#R`, near "killed") sends `IE(r, "SIGTERM")`,
  then after a grace period `process.kill(-r, "SIGKILL")` plus SIGKILL to each
  descendant again (checked by start time, so a reused pid is not hit).

So the reviewer's description is right, with one correction: the list is not
"recorded" at spawn. It is built from the parent-pid tree when the kill happens.
A process escapes only if it is both outside the call's process group and no
longer under the call's shell in the parent tree. A double fork does both.

Cloud-runner session end (`reapDescendants`) also walks the parent tree plus the
process group, so a double-forked process escapes that too. Local session exit
and `run_in_background` calls were not traced; the same `IE` path is likely but
unproven.

### Stand-in test

An emulation of `A0` (ppid walk, SIGKILL to the group, SIGKILL to each pid) on a
call shell started in its own session, which launched four sleeps:

| Launch | pgid | ppid | Result |
|---|---|---|---|
| `sleep &` | call's | shell | killed (group) |
| `nohup sleep &` | call's | shell | killed (group) |
| setsid only (perl, no fork) | own | shell | killed (per-pid, found by ppid walk) |
| fork, setsid, exec (the guard's pattern) | own | 1 (launchd) | **survived** |

Also tested in a real Bash call: a double-forked `sleep 8` with no output redirect
did not hold the call open (the call returned about 2 s in; the sleep ran on).
Redirecting is still right, so its output goes to a log and not to a dead file.

Note: macOS has no `setsid` command (`which -a setsid` finds nothing), so
"setsid alone" is not even an option here without perl.

### Conflict with the section

The section says long-lived processes go through `service` (launchd) or
`svc-tmux up`. An unscoped double-fork rule invites a third, ownerless way to
start a dev server. The double-forked process has no stop command, no status and
no log unless the caller adds them. Scope the advice to short, self-ending
watchers, and point long-lived work at the existing two.

The example path `~/projects/sekhmet/native-host/reload-guarded` names a private
project in a public file. Drop it, or keep only "see the project's own example".

### Revised text (a short subsection at the end of the section)

> ### Outliving a Bash call
>
> Stopping a Bash call (Esc or timeout) kills its process group, then each
> descendant found by parent pid. `nohup` does not escape this, and macOS has no
> `setsid` command. For a long-lived process use `service` or `svc-tmux up`.
> A short watcher that must outlive the call forks twice, so its parent is
> launchd, and must end on its own time limit:
> `perl -MPOSIX -e 'fork and exit 0; POSIX::setsid() != -1 or die "setsid: $!"; exec @ARGV or die "exec: $!"' CMD ARGS </dev/null >>LOG 2>&1`

## Worse defects found nearby

None that blocks. Two to note:

1. Suggestion 1 as written states that `executeScript` and `sendMessage` wake a
   sleeping tab. That is false and could lead someone to reload tabs to "fix" a
   failed send, which is the original bug.
2. Suggestion 3 as written says Claude Code kills "each child it recorded". The
   real list is built at kill time from parent pids. The difference matters: a
   process only escapes once its parent has already exited, which is why the
   first fork must exit before the kill.

## Suggestion 5: the loose preflight match in guard.sh

Verdict: **changed**. The false match is real, but not from the process the
suggestion names. The proposed fix drops one leftover the check now catches.

### Is the false match real?

`guard.sh:79` runs `pgrep -f "sekhmet-reload-test\."`. The pattern is a regex: the
literal text `sekhmet-reload-test.` anywhere in a command line.

- **The shell that runs guard.sh does not match.** macOS pgrep leaves out itself
  and all its ancestors unless `-a` is given (`man pgrep`). Tested: this Bash
  call's own shell had `sekhmet-reload-test.` in its command line. Plain
  `pgrep -f` did not list it; `pgrep -af` did.
- **Any other process with the text does match.** Tested: a stand-in
  `bash -c 'sleep 15; : sekhmet-reload-test.abc'` matched. Real examples: another
  session's Bash call or `run_in_background` call that names a test folder, a
  `tail -f` or `Monitor` on a test log, an editor, `rg`.
- **`\.` matters.** A command line holding the pattern itself
  (`sekhmet-reload-test\.`, with the backslash) does not match, because the
  backslash sits between `test` and `.`. Tested.

The `dev_reload_host.py` false refusals had the same cause (some process that was
not an ancestor), not the calling shell.

### Does the proposed fix still catch every leftover?

| Leftover | Token in its command line? | Old pattern | Brave-only pattern |
|---|---|---|---|
| Brave main (`--user-data-dir=$ROOT/profile`) | yes | caught | caught |
| Brave helpers and crashpad that carry the token | yes | caught | caught (same bundle path) |
| Brave processes without the token | no | missed | missed |
| node driver (`node .../drive.mjs <scenario> 9341 $ROOT/ext`) | yes | caught | **missed** |
| reload-guarded started by the driver (token only in its environment) | no | missed | missed |

Tested with a stand-in `node .../reload-test/drive.mjs self 9341 .../sekhmet-reload-test.Ab12Cd/ext`.
The old pattern caught it; the Brave-only pattern did not.

Risk of the gap: low. A driver outlives guard.sh only if guard.sh alone is
SIGKILLed. It polls port 9341 for about 10 s at start, so it could attach to the
next test's Brave only in that window. After its Brave dies it most likely
hangs idle. The check costs nothing to keep, so keep it. A leftover
reload-guarded ends on its own in 20 s, aims only at a Brave with its own start
time, and needs no check.

### Revised fix

```bash
leftovers() {
    pgrep -f '^/Applications/Brave Browser\.app/.*sekhmet-reload-test\.'
    pgrep -f '(^|/)node [^ ]*/reload-test/drive\.mjs .*sekhmet-reload-test\.'
}
if [ -n "$(leftovers)" ]; then
    echo "GUARD: a previous test's processes are still alive, not starting:"
    ps -o pid=,command= -p "$(leftovers | paste -sd, -)"; exit 2
fi
```

Both patterns were tested against the stand-in driver; the driver pattern matched it.

### Other loose matches

None with the same flaw. Every other match is tied to a process group, a pid, or
an anchored Brave path:

- `guard.sh` `brave_pids` takes the bundle path from the start of the command,
  and the token through `ENVIRON`. Lines 162 and 176 use `pgrep -g` or a group
  kill. Lines 163, 174, 184 and 211 are anchored to `^/Applications/Brave Browser\.app/`.
- `reload-guarded` `HELPER_RE` is `[Pp]ython[0-9.]* /.*/dev_reload_host\.py$`.
  The `$` and the absolute path keep shells out. The live helper matches it,
  because `run_dev_reload_host.sh` passes no arguments. Line 212 also scopes the
  match to Brave's group. A hand-run copy of the helper would make it refuse,
  which fails safe.
- `reload-guarded:163` (`*"$RELOAD_EXPECT"*`) is guarded by `[ -n ... ]`, so an
  empty value does not match everything.
- `drive.mjs:37` uses the narrowed helper pattern, and `drive.mjs:230` uses `pgrep -g`.
