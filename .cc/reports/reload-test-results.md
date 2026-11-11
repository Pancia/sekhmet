# Reload test results

Date: 2026-11-10. Harness: `.cc/scripts/reload-test/` (safety review:
`reload-test-safety-review.md`). Headless Brave 157, throwaway profile,
developer mode on, Sekhmet loaded from a copy. No tabs open besides
`chrome://extensions`.

| Scenario | Reloaded? | State after | Brave footprint | Runaway |
|---|---|---|---|---|
| `button` (extensions page Reload) | yes, new background page | ENABLED | flat, about 190-200 MB | no |
| `self` (Sekhmet `runtime.reload()`) | yes, new background page | ENABLED | flat, about 190-200 MB | no |
| `button-tabs` (YouTube video + x.com post open, both refreshed 2 s after) | yes | ENABLED | 360-525 MB, levels off | no |
| `self-tabs` (the same, with `runtime.reload()`) | yes | ENABLED | 200-509 MB, levels off | no |
| `devreload-tabs`, windowed (`HEADED=1`, GPU on) | yes, helper reconnected, both tabs refreshed | ENABLED | 1.1-1.4 GB, flat after the reload, falling at the end | no |
| `devreload-tabs` (copy has `dev-reload.js` in its manifest; reload sent with `native-host/reload-extension x.css lib.js`; dev-reload.js refreshed both tabs) | yes | ENABLED | 170-517 MB, levels off | no |

Conclusion: the second incident's whole chain - pipe helper, push, self-reload,
the new background page reconnecting (a new helper started), and both tabs
refreshed - runs cleanly in headless Brave. The incidents did not reproduce.
What differs from the user's Brave: a window rather than headless, the user's
full profile (other extensions, many tabs), and an install made with "Load
unpacked" by hand. In the second incident no new helper ever started after the
reload, so in the real Brave the reloaded background page never got going -
which points at the browser side, not at Sekhmet's own code. In the first
incident the 4 GB was in Brave's main (browser) process, not in a tab, which
fits the same reading.

A windowed run (`HEADED=1`) of the same chain was clean too. Its first try
tripped the guard 2 s after the reload, but on machine-wide compressed memory
that had been rising since launch while the window loaded YouTube; the guard
now measures those from the moment of the reload.

So the remaining differences are the user's own profile (other extensions, many
tabs, long uptime) and the hand-made "Load unpacked" install. Since the Reload
button's path is what the user uses every day without trouble, the practical
answer is to trigger that path rather than `runtime.reload()`.

Not tested: the polling version of dev-reload.js (first incident), which is in
the Trash.

Harness notes from the runs:
- System-wide compressed memory moves by 1-2 GB in 30 s from other apps, so it
  is a poor signal about the test Brave. `footprint` per process is the
  reliable one; the guard samples it every 2 s.
- Summed resident memory (about 600 MB) overcounts: it counts the shared
  framework once per process. Footprint is about 200 MB.
- `mini-self` was not run: with no runaway from Sekhmet, there was nothing to
  compare it against.

## Guarded reload command

`native-host/reload-guarded [files...]` sends the reload through the pipe, then
watches the Brave that started the pipe helper for 60 s (footprint and
available memory). On more than 2 GB of growth or under 20% available it
quits that Brave (SIGTERM, then SIGKILL of its process group after 5 s).

| Scenario | Result |
|---|---|
| `guarded-tabs` (20 s watch) | reload sent, "Sekhmet is back after 1 s", footprint 406 -> 418 MB, exit 0 |
| `guarded-runaway` (a tab eats about 1 GB, limit lowered to 600 MB) | tripped at +1108 MB (1525 MB), quit the test Brave by SIGTERM within 5 s; the user's own Brave untouched |

Overshoot past the limit was about 500 MB at a growth rate of about 430 MB/s:
one footprint sample of a whole Brave takes about a second.

## Third incident: the guarded reload in the real Brave (2026-11-11)

`native-host/reload-guarded lib.js` against the user's own Brave (dev-reload.js
back in the manifest, Sekhmet reloaded by hand first). Memory ran away into
swap again and the user had to force-quit Brave. The guard did not act. The
Claude session running the command ended mid-run, so its output is lost.

Why the guard may not have acted (not known which):
- It ran as a child of the Claude session's shell; if that session was killed
  under the memory pressure, the guard died with it.
- It had no swap trip. With swap available, available memory (memorystatus
  level) may never have fallen under 20%.
- Each check called `footprint` over all of Brave's processes; under heavy
  swapping that call can stall, and the loop checks nothing while it waits.

Status: self-reload in the real Brave reproduced three times out of three; in
throwaway Brave profiles never. dev-reload.js is out of the manifest again.
No Jetsam or diagnostic report was written for the incident.

## Cause found (2026-11-11): the tab refresh, not the reload

Read from the user's own Brave (tab list through AppleScript, read-only; process
list): **1,931 tabs** in 8 windows, and about **13 page processes**. So nearly
every tab is asleep: restored at start-up and never loaded, or discarded.

| Tabs the old `dev-reload.js` refreshed for `lib.js` | Count |
|---|---|
| youtube.com (1,155 of them watch pages) | 1,279 |
| duckduckgo.com | 9 |
| watch.thechosen.tv | 3 |
| pinterest | 2 |
| x.com | 1 |
| **Total** | **1,294** |

`tabs.reload()` on a sleeping tab loads it. The old code called it for every
matching tab at once, so each incident tried to load about 1,290 pages, most of
them YouTube watch pages. That is the runaway. It explains every observation:

- Real Brave 3 of 3, throwaway Brave 0 of all runs: the tests had 2 tabs.
- The Reload button never does it: the button refreshes no tab.
- Incident 1, 4.1 GB in the main process: 1,290 page loads start there.
- Incident 2, no new pipe helper: the new background page asked for the 1,290
  refreshes *before* it connected to the helper, and the browser was swamped.

Not the cause: Sekhmet's `storage.local` (5 MB on disk), `runtime.reload()`
itself (clean in every test), the "Load unpacked" install.

Chromium's `ExtensionTabUtil::GetLoadingStatus` gives `status: "unloaded"` to
any tab with no live page process, and its comments name the session-restored,
not-yet-loaded tab as a case that is unloaded but not `discarded`. So the fix
checks both fields.

### Shown small in the throwaway Brave

Scenario `devreload-sleeping-tabs`: 16 light tabs (example.com), 4 of them
discarded first, reload sent with `reload-extension picker-target.js`.

| `dev-reload.js` | Asleep after | Loaded tabs refreshed | Peak footprint |
|---|---|---|---|
| old (refresh every matching tab) | **0 of 4** - all four were loaded | 12 of 12 | 561 MB |
| new (loaded tabs only, 10 at most) | 4 of 4 | 10 of 12 | 538 MB |
| new, `--no-refresh` (`devreload-norefresh-tabs`) | 4 of 4 | 0 of 12 | 531 MB |

In every run the extension reloaded and a new pipe helper started.

### What changed

The user chose to drop the tab refresh entirely (a cap of 10 loaded tabs was
built and tested first, then removed).

- `dev-reload.js` reloads the extension and refreshes no tab. It removes the
  old version's pending list (`sekhmet_devReloadTabs`) from storage at start.
- `lib.js` (`watchForExtensionReload`): each loaded tab holds a port open to the
  background page. When it closes in a reload, the tab shows a toast,
  "Sekhmet was updated - Click to reload this tab", with a close button. Only
  a click reloads the tab. Sleeping tabs run no script and show nothing. It
  works for the Reload button too. The first reload after it is installed shows
  no toast, because the code that shows it is the old one.
- `background.js`: one no-op `runtime.onConnect` listener, so the port stays open.
- `native-host/reload-guarded`, rebuilt on the lessons of the third incident:
  the watching runs in its own session and logs to
  `~/.local/share/sekhmet/reload-guarded.log`; it checks swap growth, memory
  level, the count of Brave page processes and resident memory twice a second;
  a separate process samples `footprint`. It refuses to send when two pipe
  helpers run.

| Scenario (throwaway Brave) | Result |
|---|---|
| `devreload-sleeping-tabs`, final code | 4 of 4 still asleep, 0 of 12 loaded tabs refreshed |
| `button-toast-tabs` | after the reload both tabs (DuckDuckGo, YouTube) show the toast and neither reloads; a click on the DuckDuckGo toast reloads that tab only; after a second reload the clicked tab shows the toast again |
| `devreload-toast-tabs` | the same through the pipe; the new pipe helper started |
| `guarded-tabs` | reload sent, back after 0 s, footprint 394 -> peak 537 MB, exit 0 |
| `guarded-runaway` (a tab eats about 1 GB, limit 600 MB) | tripped on footprint +841 MB, quit the test Brave, exit 3 |
| `guarded-wake` (6 new tabs after the reload, limit 3 new page processes) | tripped on 7 new page processes within a second, quit the test Brave, exit 3 |
| stand-in check (no browser) | the watcher's process group differs from the starter's; it outlived `kill -KILL` of the starter's whole group |

Not yet done: any run in the user's real Brave. `dev-reload.js` is still out of
the manifest. Review before that run: `reload-real-run-safety-review.md`.

## First run in the real Brave (2026-11-11, 09:33 MST): clean

`dev-reload.js` back in the manifest, one hand reload, then
`native-host/reload-guarded lib.js` from a Claude Bash call. Log:
`~/.local/share/sekhmet/reload-guarded/20261111-093317.log`.

- Sekhmet came back in under 1 s (a new pipe helper started).
- Page processes 13 -> 13 for the whole 60 s: no tab was loaded.
- Footprint 2,176 -> 2,145 MB (peak 2,195 MB); swap 2,097 MB throughout;
  memory level 71-72%.
- Exit 0.

