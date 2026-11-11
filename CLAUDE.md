# Sekhmet

Manifest V2 extension, installed unpacked in **Brave** (not Chrome).

- Tests: see README "Tests". `node test/run.js` and `node test/check.js`;
  run both before saying a change is done.
- Loading a change: run `native-host/reload-guarded [changed files]`, with a
  Bash timeout of at least 180000 ms. It reloads Sekhmet, refreshes no tab, and
  quits Brave if memory runs away in the next 60 s (log in
  `~/.local/share/sekhmet/reload-guarded/`). Open tabs keep their old scripts:
  each loaded tab shows a "Sekhmet was updated" toast and reloads on a click.
  Say which files changed and which tabs need that click. If the command
  refuses or does not exit 0, say so; the user then reloads by hand on
  `brave://extensions`.
- Reload Sekhmet no other way: not `native-host/reload-extension` alone, not
  `runtime.reload()`, and nothing that refreshes tabs. Refreshing every
  matching tab loaded about 1,290 sleeping tabs at once and made Brave's
  memory run away three times (`.cc/reports/reload-test-results.md`). Ask
  before you add code that reloads a tab without a click, or remove
  `dev-reload.js` from the manifest. Reload tests in a browser go through
  `.cc/scripts/reload-test/guard.sh` only.
- The user's Brave has well over 1,000 tabs open (1,931 on 2026-11-11), and
  nearly all are asleep: restored but never loaded, or discarded. Code that runs
  over many tabs must skip sleeping ones (`tab.discarded || tab.status ===
  'unloaded'`) and cap how many it touches. Reloading, navigating, activating or
  duplicating a sleeping tab loads it. `executeScript` and `sendMessage` do not
  load it; they fail ("Frame with ID 0 is not ready", "Receiving end does not
  exist"), so catch the error.
- Browser checks: headless Google Chrome ignores `--load-extension`; headless
  Brave loads the unpacked extension. Fixture scripts that drive the content
  scripts on a fake watch page live in `.cc/scripts/browser/` (see its README).
  `.cc/scripts/pinterest-e2e.js` loads the real extension in headless Brave.
- Change a site's own elements with attributes and CSS; do not move or copy
  them, because the site's framework owns them. If a plan needs copied or
  moved elements, first say what they lose (buttons, click handlers, the
  site's own loading) and ask before building.
- For a site you can only probe logged out, have the content script log one
  line per page from the first version, saying what it matched and how many.
  Ask the user for that line when they report it not working. Every log line
  starts with `[YT+]`, so tell them to filter the console by the module name,
  for example `[pinterest]`.
