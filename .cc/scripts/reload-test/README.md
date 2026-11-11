# Reload test

Finds out why reloading Sekhmet made Brave's memory run away (twice, to
10-20 GB of swap). Each run starts a throwaway headless Brave, loads an
extension, reloads it one way, and records memory each second.

```
.cc/scripts/reload-test/guard.sh button    <outdir>   # the Reload button's path
.cc/scripts/reload-test/guard.sh self      <outdir>   # Sekhmet: runtime.reload()
.cc/scripts/reload-test/guard.sh mini-self <outdir>   # a two-file extension: runtime.reload()
```

More scenarios are listed at the top of `drive.mjs`. The ones that found the
cause: `devreload-sleeping-tabs` (16 light tabs, 4 asleep: which tabs does
`dev-reload.js` refresh?), `devreload-norefresh-tabs`, and `guarded-wake` (the
guard must quit Brave when tabs start to load).

Run them one at a time, each under a tool timeout of at least 300 s.
`guard.sh` owns Brave and kills its whole process tree on the first of: 1.5 GB
of Brave memory, 512 MB of swap growth, 1 GB of compressor RAM growth, 2 GB of
compressed-memory growth, available memory under 20%, 75 seconds, or the driver
ending. A watchdog kills Brave if `guard.sh` itself dies, and at 120 seconds.
It will not start with under 25% of memory available, under 5 GB of disk free,
or a previous test still alive. It ends by saying whether any test process is
left. Output: `<scenario>.timeline.csv` and `<scenario>.driver.log`.

The extension is copied into the test's temp folder, never loaded from the
repo. Developer mode is turned on first, as in your own Brave.

The safety review behind this design: `.cc/reports/reload-test-safety-review.md`.
