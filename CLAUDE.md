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
  reload files as they are.
- Browser checks: headless Google Chrome ignores `--load-extension`; headless
  Brave loads the unpacked extension. Fixture scripts that drive the content
  scripts on a fake watch page live in `.cc/scripts/browser/` (see its README).
