# Browser fixtures

Two scripts that drive the real `lib.js`, `loop.js` and `feeling-tracker.js`
in headless Google Chrome, on a fake YouTube watch page served by request
interception. Each prints `PASS`/`FAIL` lines and exits 1 on any failure.

- `drive.js`: the loop range in the compass menu: typed times, the timeline
  bar (click, drag, clamping), "Use current time", whole-video and off, and the
  menu redrawing after navigation. About 25 seconds.
- `countdown.js`: the check-in countdown ring: counting, pausing, the last 10
  seconds, clicking early, the opening grace period, leaving for the feed and
  coming back to the same video (the miniplayer path), fullscreen, and videos
  too short for the grace period. About 2.5 minutes.

## Run

Needs Node, ffmpeg and Google Chrome.

```
cd .cc/scripts/browser
npm install
./make-clips.sh
node drive.js
node countdown.js
```

`node_modules`, the lock file, the clips and `out/` are ignored by git.
Screenshots and logs go to `out/`. Browser profiles go to a temp folder and are
deleted after each run.

## Notes

- The scripts inject the files themselves, so they need no extension install.
  Google Chrome is the default. Set `SEKHMET_BROWSER` to another Chromium to use
  it. Brave works too.
- The injected files run in the page's main world, not the isolated world a
  real content script gets. Behaviour that depends on that difference is not
  covered here. To load the real unpacked extension, use headless Brave with
  `--load-extension`; Google Chrome ignores that flag.
- `countdown.js` replaces `Date.now` in the page to cross the 7.5-minute
  interval quickly. It reads `CHECK_INTERVAL_MINUTES` as 7.5; update `INTERVAL`
  if that changes.
- `SEKHMET_ROOT=<dir>` runs the scripts against another copy of the files, for
  example to confirm that a check fails when a fix is reverted.
