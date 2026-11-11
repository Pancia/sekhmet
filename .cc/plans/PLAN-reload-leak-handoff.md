# Handoff: why does reloading Sekhmet make Brave's memory run away?

Repo: `/Users/anthony/projects/sekhmet` (Sekhmet, a Manifest V2 extension,
installed with "Load unpacked" in Brave 157 on an M1 Mac mini with 16 GB of RAM
and about 5 GB of free disk). Read the project `CLAUDE.md` first.

## Goal

A shell command that an AI can run to reload Sekhmet in the user's **real**
Brave without Brave's memory running away. The user has ruled out:
- turning on Brave's "Allow JavaScript from Apple Events" setting
- reloading on a timer or file watch (an auto reload)

Today the user reloads by hand with the Reload button on `brave://extensions`.
That works every day with no trouble.

## What happened: three incidents, all in the real Brave

Each time, Sekhmet's background page called `runtime.reload()` on itself, then
the restarted page refreshed every open tab whose content scripts load a
changed file. Memory then ran away into swap until the user force-quit Brave.

1. **2026-10-22, polling version.** `dev-reload.js` fetched every file the
   manifest names once a second, and reloaded on a change. After an edit to
   `lib.js`, `ytdl.js` and `feeling-tracker.js`, Brave's **main (browser)
   process** held 4.1 GB, most of it compressed, and swap hit 16.9 of 17.4 GB.
   One confounding factor: a leaked headless test Brave was also running then.
2. **2026-10-22, push version.** The polling was replaced by a native
   messaging host (`com.sekhmet.dev_reload`, `native-host/dev_reload_host.py`)
   that waits on a named pipe at `~/.local/share/sekhmet/reload.fifo`.
   `native-host/reload-extension lib.js` wrote to it. The old host exited, but
   **no new host ever started**. So the reloaded background page never ran
   `connectNative`, which suggests the reload got stuck. Memory ran away, and
   the user killed Brave.
3. **2026-11-11, guarded.** The same push went through `native-host/reload-guarded
   lib.js`, which was meant to quit Brave on a runaway. Memory ran away again.
   The guard did not act, and the Claude session running it ended mid-run, so
   its output is lost.

`lib.js` is in **every** content script entry. So each reload refreshed every
open tab on YouTube, x.com, DuckDuckGo, Pinterest and the other matched sites,
except tabs playing sound. The user usually has many such tabs open.

## What was tested and never reproduced it

Harness: `.cc/scripts/reload-test/` (`guard.sh`, `drive.mjs`, README). Safety
review: `.cc/reports/reload-test-safety-review.md`. Results:
`.cc/reports/reload-test-results.md`.

The tests used throwaway Brave profiles, developer mode on, and Sekhmet loaded
from a temp copy through CDP `Extensions.loadUnpacked`. They covered both
reload methods (the extensions page's `developerPrivate.reload`, and
`runtime.reload()`), with no tabs and with one YouTube and one x.com tab open.
They also ran the full push chain with `dev-reload.js`, headless and in a
window. Every run reloaded correctly, the new host started, both tabs
refreshed, and memory levelled off at 0.2 to 1.4 GB.

## Differences between the tests and the real Brave (leads, untested)

- **Number of tabs refreshed at once.** The tests refreshed 2 tabs. The real
  Brave refreshes every matching tab at once. This is the cheapest lead to
  test: open 20 to 40 YouTube and x.com tabs in the test Brave first.
- **The real profile:** other extensions (Sekhmet's element picker writes
  uBlock rules), Sekhmet's `storage.local` (gate wallpapers are stored as data
  URLs, with `unlimitedStorage`), and long uptime.
- **The install type:** "Load unpacked" by hand, versus CDP load in the tests.
- **Incident 2's missing host** points at the browser side: the reloaded
  background page never got going, and incident 1's memory sat in the main
  process, not in a tab.

## Safety rules (the user cares about this most)

- **Never run a self-reload in the user's real Brave without asking first.**
  Each try cost a force-quit.
- `dev-reload.js` is **not** in the manifest. Do not add it back without asking.
- Run browser tests only through `.cc/scripts/reload-test/guard.sh`. It owns the
  browser, has a watchdog, and kills the whole process tree. Earlier, a test
  script that exited early leaked a headless Brave that ate gigabytes.
- **Lessons from the failed guard,** for any guard on the real Brave:
  - Run it detached from the Claude session (for example `nohup` with its own
    session), so it survives the session dying.
  - Include a swap-growth trip.
  - Keep the fast checks (`sysctl` swap, `kern.memorystatus_level`, `ps` RSS)
    in a loop that never waits on `footprint`. `footprint` can stall under
    heavy swapping, so sample it in a separate process.
- Resident memory (RSS) undercounts compressed and swapped memory. Use
  `footprint` (one call over many pids gives a "Summary Footprint") for the
  true size.
- The user asked for a review by a separate agent before risky runs.

## Files (all uncommitted, untracked)

`dev-reload.js`, `native-host/dev_reload_host.py`,
`native-host/run_dev_reload_host.sh`, `native-host/reload-extension`,
`native-host/reload-guarded`, the `com.sekhmet.dev_reload` entry in
`native-host/install.sh` (it is already registered in Brave's
NativeMessagingHosts folder), `.cc/scripts/reload-test/`, and the two
`.cc/reports/reload-test-*.md` files.

Other uncommitted changes in the repo (`background.js`, `picker.js`,
`prompts_host.py` and others) belong to other sessions. Leave them alone.

## Update 2026-11-11: cause found

The cause is the tab refresh. The real Brave has 1,931 tabs, about 1,290 match
`lib.js`, and only about 13 are loaded. The old `dev-reload.js` refreshed all
of them, and a refresh loads a sleeping tab. Details, the small reproduction
and the fix: `.cc/reports/reload-test-results.md`, section "Cause found".

State: `dev-reload.js` refreshes no tab; each loaded tab offers a "click to
reload" toast instead (`lib.js`, `watchForExtensionReload`). `reload-guarded` is rebuilt
(detached, swap trip, page-process trip, footprint sampled apart). All of it is
tested in throwaway Braves only. Next: the user's go-ahead for a first run in
the real Brave, `native-host/reload-guarded`, after
`dev-reload.js` goes back into the manifest and one hand reload.

## Update 2026-11-11 09:34: first real run clean

`native-host/reload-guarded lib.js` ran in the real Brave: no tab loaded,
memory flat, exit 0. See the results report, last section.

