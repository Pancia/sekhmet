# Sekhmet

Manifest V2 extension, installed unpacked in **Brave** (not Chrome).

- Tests: see README "Tests". `node test/run.js` and `node test/check.js`;
  run both before saying a change is done.
- Loading a change: the user reloads Sekhmet by hand on `brave://extensions`.
  Say which files changed and that a reload is needed.
- Self-reload is **disabled**. `dev-reload.js` is not in the manifest because
  `runtime.reload()` made Brave's memory run away twice. Do not run
  `native-host/reload-extension`, do not tell the user to run it, and do not
  add `dev-reload.js` back to the manifest without asking. Leave the leftover
  reload files as they are. This includes the uncommitted `dev-reload.js` line
  in README.md and the change to `native-host/install.sh`. Keep them out of
  commits.
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
