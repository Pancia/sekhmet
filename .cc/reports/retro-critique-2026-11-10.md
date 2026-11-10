# Critique of the retro proposals (loop range + countdown session)

Date: 2026-11-10. Scope: the six proposals from the retro of session a9b77064.
Every claim below was checked against the files, the git history, the session
transcripts, or a throwaway test under the session scratchpad. Nothing in the
project, `~/dotfiles` or `~/.claude` was changed.

| # | Proposal | Verdict |
|---|----------|---------|
| 1 | Keep the browser test fixtures | Changed |
| 2 | Add a project CLAUDE.md | Changed (premise wrong, more important content found) |
| 3 | Hunk-picking helper for the commit command | Changed (no helper; rewrite the step) |
| 4 | Rule about long inline scripts | Rejected (cause found; it is not length) |
| 5 | player-bridge.js "Unsafe attempt" errors | Confirmed, cause established |
| 6 | Artifact link in the mockup file | Confirmed, low value |

---

## 1. Keep the browser test fixtures

### Diagnosis

Partly true, and the situation is worse than the proposal assumes.

- **The scripts are already gone.** `.../scratchpad/jsd/` does not exist. The
  machine booted at 15:54 MST on Nov 9 (`sysctl kern.boottime`), and the last
  edit to `countdown.js` was at 15:38 MST that day. The reboot emptied the
  scratchpad, including `node_modules` and the ffmpeg clips. "Move them" is not
  possible. They can only be rebuilt.
- **They can be rebuilt exactly.** The session transcript
  (`~/.claude/projects/-Users-anthony-projects-sekhmet/a9b77064-....jsonl`) holds
  the original `Write` of `drive.js` (line 131) and `countdown.js` (line 367),
  and every later `Edit` (lines 267, 302, 393, 457, 627, 628, 763). Replaying
  them in order gives the final files.
- **The feed-and-back scenario already existed.** The edit at line 763 added the
  `ONLY=mini` mode: it goes to `/`, back to the same `/watch?v=AAA`, then to a
  different video. That edit came after the user reported the bug. So the gap
  was real at the time, but the fix was written. It was lost with the rest.
- **The scripts only print observations.** They `console.log` values for a
  person to read. Nothing fails and the exit code is always 0. As written, they
  are not a regression guard, even if they are kept.

Run steps recovered from the transcript:

```
npm i puppeteer-core@23
ffmpeg -y -loglevel error -f lavfi -i testsrc=size=640x360:rate=24:duration=30 -c:v libx264 -pix_fmt yuv420p -g 12 v.mp4
ffmpeg -y -loglevel error -f lavfi -i testsrc=size=640x360:rate=12:duration=120 -c:v libx264 -pix_fmt yuv420p -g 12 long.mp4
```

Chrome path: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

### Is `test/picker-page.html` a better pattern?

No, not for these two features. It is a static page opened from `file://` and
run with `--headless --dump-dom --virtual-time-budget`. That works for
`picker.js` because the picker has no host gate. `loop.js:73` and
`feeling-tracker.js:321` return early unless `location.hostname` is
`www.youtube.com` and the path holds `/watch`. A `file://` page cannot meet that.
The countdown tests also need things `--dump-dom` cannot give: real video
playback, a user gesture for `requestFullscreen`, mouse drags on the timeline,
and SPA navigation. Puppeteer's request interception is the right tool here.

What is worth copying from `picker-page.html`: it checks itself and prints
`PASS`/`FAIL` lines, it has no dependencies, and its run command is in its
header.

### Something the proposal did not know

The premise "the real extension could not be loaded in a test browser" is only
true of Google Chrome. I tested both, headless, each with a throwaway profile:

- Chrome 157 ignores `--load-extension`. No background page; no content scripts.
- Brave 157 loads the unpacked extension. The content scripts ran on a page
  served by interception, and `player-bridge.js` reached the page.

So a real-extension run is possible with Brave. It is not a full replacement.
Real content scripts run in an isolated world, and the countdown tests fake the
clock by replacing `Date.now` in the main world, which an isolated world does
not see. The current approach also has a fidelity gap of its own:
`addScriptTag` runs `lib.js`, `loop.js` and `feeling-tracker.js` in the **main**
world, not in the isolated world the browser uses. Note also that after
`runtime.reload()` in headless Brave, content scripts stopped running entirely.
An earlier session saw the same thing. Do not build tests on a reload.

### Would the proposed fix work, and what could it break?

Moving the scripts into `.cc/scripts/` as written would cause problems:

- `ROOT` is hard-coded to `/Users/anthony/projects/sekhmet`. The repo is public
  on GitHub (`gh api repos/Pancia/sekhmet` reports `private: false`).
- They write the Chrome profile (`profile`, `profile3`) and screenshots
  (`a.png`, `b.png`, `cd-*.png`) next to themselves. In `.cc/` that is a tracked
  tree, and a Chrome profile is tens of MB.
- `node_modules` and the clips would land in the tracked tree unless ignored.

### Revised fix

1. Rebuild `drive.js` and `countdown.js` by replaying the transcript's Write and
   Edit calls. Put them in `.cc/scripts/browser/`.
2. Add these files there:
   - `package.json`: `{"private": true, "dependencies": {"puppeteer-core": "23"}}`.
     It sits in `.cc/scripts/browser/`, so the "no package.json" rule for
     `test/` still holds.
   - `.gitignore`: `node_modules/`, `*.mp4`, `out/`.
   - `make-clips.sh`: the two ffmpeg commands above.
   - `README.md`: `npm i` in this folder, `./make-clips.sh`, then
     `node drive.js` and `node countdown.js`. Needs Google Chrome and ffmpeg.
     Takes about 3 minutes.
3. In both scripts:
   - `ROOT = path.resolve(__dirname, '../../..')`.
   - Write the profile and screenshots to `out/` (ignored), or to
     `fs.mkdtempSync(os.tmpdir() + '/sekhmet-')`. Delete the profile in a
     `finally`.
   - Turn each `console.log` observation into a check that prints
     `PASS`/`FAIL`, and exit 1 on any failure.
4. Make the feed-and-back scenario part of the default run, not an `ONLY=mini`
   early exit. It must assert three things: the ring comes back on the same
   video; its value carries on from where it was (it does not restart the
   60-second hold); and a different video does restart it.
5. Optional and cheaper: pull the "new id restarts the grace clock, no id keeps
   it" rule out of the `setInterval` in `startPlayTimeTracking()`
   (feeling-tracker.js, near line 653) into a small named function, and test it
   in `test/` under node. That guard runs with `node test/run.js` every time and
   does not rot like a browser script.

Effort: about 1 to 2 hours for steps 1 to 4.

---

## 2. Add a project CLAUDE.md

### Diagnosis

The facts listed (test commands, reload tool, commit trailer) are real, but the
most important one is wrong.

- **`native-host/reload-extension` cannot work right now.** `dev-reload.js` is
  not in `manifest.json`'s background scripts (they are `polyfill.js` and
  `background.js` only). No `dev_reload_host` process runs. The pipe
  `~/.local/share/sekhmet/reload.fifo` has no reader, so the command would print
  "Sekhmet is not listening" and exit 1.
- **It was turned off on purpose.** In session e39df6d1, the self-reload was
  tried twice in the user's real Brave, first polling and then push-based. Both
  times Brave's memory ran away and Brave had to be killed. That session took
  `dev-reload.js` out of the manifest and said self-reloading is "off for good
  unless you decide otherwise". It also asked whether to delete the reload
  pieces. I found no answer to that question.
- **The README still documents it as working.** The `dev-reload.js` entry in
  `README.md` says to run `native-host/reload-extension` after an edit. That
  line, `dev-reload.js` and the three native-host files are uncommitted work
  left from e39df6d1. The retro session read that README, and then told the user
  six times to run a command that does nothing. The user reloaded by hand
  because that is the only way that works. They did not reload by hand because
  the assistant failed to run the command.
- **The user's browser is Brave,** not Chrome (`brave://extensions`, Brave
  processes running). Chrome is only the headless test browser.
- **The commit trailer does not belong in a project file.** The harness injects
  the attribution lines each session, and the model name in the trailer changes
  over time. A copy in CLAUDE.md would go stale.
- **The test commands are already in README's "Tests" section** (`cmds test` /
  `node test/run.js`, `cmds check` / `node test/check.js`). A pointer is enough.

### Should the assistant run the reload itself?

No. First, it does nothing today. If it is ever re-enabled, it calls
`runtime.reload()`, which is the step linked to Brave's memory blowups. It also
refreshes every tab whose content scripts use a changed file, except tabs that
are playing sound. A paused video, an open check-in dialog, or a half-set loop
range is lost without warning. That would disrupt the user in the middle of a
test.

### Revised fix

Create `/Users/anthony/projects/sekhmet/CLAUDE.md`:

```markdown
# Sekhmet

Manifest V2 extension, installed unpacked in **Brave** (not Chrome).

- Tests: see README "Tests". `node test/run.js` and `node test/check.js`;
  run both before saying a change is done.
- Loading a change: the user reloads Sekhmet by hand on `brave://extensions`.
  Say which files changed and that a reload is needed.
- Self-reload is **disabled**. `dev-reload.js` is not in the manifest because
  `runtime.reload()` made Brave's memory run away twice. Do not run
  `native-host/reload-extension`, do not tell the user to run it, and do not
  add `dev-reload.js` back to the manifest without asking.
- Browser checks: headless Google Chrome ignores `--load-extension`; headless
  Brave loads the unpacked extension. Scripts for this live in
  `.cc/scripts/browser/`.
```

Drop the last bullet if proposal 1 is not done.

Also put the open question from e39df6d1 to the user again: delete the reload
pieces (`dev-reload.js`, `native-host/reload-extension`,
`native-host/dev_reload_host.py`, `native-host/run_dev_reload_host.sh`, the
`install.sh` entry, the README line and the `com.sekhmet.dev_reload.json`
registrations in Brave's and Chrome's NativeMessagingHosts folders), or keep
them and mark the README line as disabled. Until that is decided, the README
line will keep misleading every session.

Effort: 10 minutes.

---

## 3. Hunk-picking helper for the commit command

### Diagnosis

True. `~/.claude/commands/cc:commit.md` is a symlink to
`~/dotfiles/ai/commands/commit.md` (the project's `.claude/commands/cc:commit.md`
links to the same file). Its "Part of a file, git" step says to write a patch
with only the group's hunks and `git apply --cached` it, and names no tool.
Nothing in `~/dotfiles/bin` does this. `commit-mine` / `ccjj` is for jj and
splits by session, not by concern. `filterdiff` and other patchutils tools are
not installed. The session's `pick_hunks.py` is still in the scratchpad.

### Would the helper work?

Only for the easy case, and the session hit both hard cases:

- **Numbering is fragile.** After the first commit, the diff against `HEAD`
  changes and the numbers move. The session had to list the hunks again.
- **A pattern selector does not fix the second case.** One README hunk mixed two
  concerns. No hunk-level selector, by number or by pattern, can split inside a
  hunk. `-U0` makes hunks smaller, but next to each other changed lines still
  form one hunk.

The session already found the method that handles every case: build the exact
content the file should have in this commit, and stage that blob. The jj step
in the same command already works this way (write the `@-` version plus this
group's hunks). I tested it in a throwaway git repo. It split two concerns on
one line, kept mode `100755`, and left the working tree untouched.

### Revised fix

No new helper. In `~/dotfiles/ai/commands/commit.md`, replace the
"Part of a file, git" bullet with:

```markdown
   - **Part of a file, git**: build the content this commit should have:
     `git show HEAD:<file> > <scratch>/<name>`, then apply only this group's
     changes to that copy with Edit. Stage it without touching the working
     tree:
     `git update-index --cacheinfo "$(git ls-files -s <file> | cut -d' ' -f1),$(git hash-object -w --path=<file> <scratch>/<name>),<file>"`.
     Check that `git diff --cached <file>` shows exactly this group's changes
     and `git diff <file>` shows the rest, then commit. This also splits a
     single hunk that mixes two concerns. Never `git add -p` (it hangs).
```

`--path` makes `hash-object` apply the file's `.gitattributes` filters. Reading
the mode from `git ls-files -s` keeps executable files executable. For a file
that is new in this commit, use mode `100644` (or `100755`).

Effort: 10 minutes.

---

## 4. Rule about long inline scripts

### Diagnosis

The inferred cause is wrong. Length is not the trigger.

- Across all saved transcripts for this project, there are about 150 Bash calls
  with heredocs. 31 of them are the `cat > file <<'EOF'` form. Many are longer
  than the refused one (58 lines), up to 545 lines in this same session. Many
  contain backticks, `$`, `&&` chains and the word `delete`. Exactly one was
  refused.
- The refused one is the only one with `$$` in the heredoc body (puppeteer's
  `p.$$(...)`).
- I reproduced it. A **3-line** quoted heredoc containing `p.$$('x')` was
  refused with the same message: "could not be checked for dangerous rm
  operations: the shell may read it differently than it was parsed". The same
  heredoc form with `delete s[k]` instead passed. `echo 'a$$b'` in single quotes
  passed too.

So the check seems to treat `$$` inside a quoted heredoc as a parse
disagreement. A "longer than 10 lines" rule would only prevent this by chance.
It would not catch a short script with `$$`.

### Is it worth a rule?

No.

- It happened once in about 150 heredocs. The session recovered on the next
  call by using Write (transcript line 131).
- The Bash tool's own guidance already says not to create files with
  `cat`/`echo` and to use the dedicated tools. A new rule would repeat that.
- The cost would be a line in every session's global instructions, read on
  every turn, to prevent one retry.

### Revised fix

None. If the user wants a note anyway, the accurate version is one line, not a
length rule: "A Bash heredoc that contains `$$` (for example puppeteer's
`page.$$`) is refused by the rm safety check; write such files with Write."

---

## 5. player-bridge.js "Unsafe attempt to load URL" errors

### Cause (high confidence, reproduced)

YouTube sends a **report-only Connection-Allowlist** header. Blink reports every
subresource request outside that list in pages that YouTube's service worker
controls. Because the header is report-only, the request is **not** blocked.

Evidence:

- `curl -D -` of a watch page and of `/sw.js` shows
  `connection-allowlist-report-only: (response-origin "https://youtube.com" "https://*.youtube.com" ...)`.
  It lists only Google and YouTube origins.
- Chromium `third_party/blink/renderer/core/loader/base_fetch_context.cc`
  (main), in `CanRequestInternal`: when `kConnectionAllowlists` is on and the
  document has a controlling service worker, a URL that does not match the
  report-only allowlist calls `PrintAccessDeniedMessage(url)`. The request is
  only blocked for the *enforced* allowlist. `PrintAccessDeniedMessage` builds
  exactly "Unsafe attempt to load URL X from frame with URL Y. Domains,
  protocols and ports must match."
- Reproduced in headless Brave 157 with a copy of the extension, on a real watch
  page:
  - First load: no message. The page was not controlled by the service worker
    yet.
  - Each reload (now controlled by the service worker): the exact message,
    logged as `security/error` with source
    `chrome-extension://.../volume.js`. On the same load, `player-bridge.js`
    returned 200, and the bridge reached the page (`data-sekhmet-vol` set).
- That source is why the entry shows up on Sekhmet's Errors page. The message is
  logged while `volume.js` (a content script) appends the `<script>`, so it is
  credited to the extension.
- It fits the screenshot: one entry per full page load, on both `/watch` and
  `/shorts` URLs (`injectBridge` runs once per document). The arrows still work.
- Only `player-bridge.js` is named. `wallpaper.html` is loaded as an iframe,
  which is a navigation and not a subresource fetch, so this check never sees
  it.

What I ruled out:

- A fresh load without service-worker control logs nothing.
- The dev reload is not involved. It is disabled (see proposal 2), and the
  message appears on plain reloads with no extension reload.
- `web_accessible_resources` is correct. A missing entry gives a different
  message ("Denying load of ...").

Remaining uncertainty: the test was in headless Brave, not the user's own
profile. The code path and the header leave little doubt.

### A worse problem nearby

If YouTube changes the header from report-only to enforced
(`Connection-Allowlist`), the bridge will stop loading in every page the
service worker controls. That means almost every page after the first visit.
`onKeyDown` already handles this well: with no reachable API, it leaves the
arrows to the page. But volume control would stop without any sign. MV2 has no
other way into the main world (`tabs.executeScript` runs in the isolated
world), so there is no cheap fallback to build now.

### Revised fix

Add a comment in `volume.js`, at the top of `injectBridge()`:

```js
        // On pages YouTube's service worker controls, Chromium logs "Unsafe
        // attempt to load URL chrome-extension://.../player-bridge.js ...
        // Domains, protocols and ports must match." That is YouTube's
        // Connection-Allowlist-Report-Only header. It only reports, so the load
        // still succeeds; the message lands on the extension's Errors page
        // because this line starts the fetch. If YouTube ever enforces the
        // allowlist, the bridge stops loading and onKeyDown leaves the arrows to
        // the page.
```

No code change. The user can clear the entries with "Clear all". They will come
back.

Effort: 5 minutes.

---

## 6. Artifact link in the mockup file

### Diagnosis

True, but less serious than stated. A new link is only made if a later session
publishes without `url` *and* does not look for one first. The Artifact tool's
`list` action shows "Sekhmet Countdown Mockups —
https://claude.ai/artifact/6yrG3S6dxyx6yZorRJnG7B", and the title is unique. The
tool's own instructions already say to recover the URL that way. Still, a
comment costs one line and makes it certain.

Constraints checked:

- The file starts with `<title>` on line 1, with no html/head/body tags. A short
  comment keeps the title well inside the first 8KB.
- The repo is public, and `.cc/` is tracked. The artifact is private by default,
  so the link gives no access. It only reveals that the artifact exists.

### Revised fix

Put the comment on line 2, after `<title>`, not before it. That way, any check
that expects the file to open with `<title>` still passes:

```html
<!-- Published at https://claude.ai/artifact/6yrG3S6dxyx6yZorRJnG7B. Republish with that url, or a new link is made. -->
```

Effort: 2 minutes.

---

## Test files left in the scratchpad

`/private/tmp/claude-501/-Users-anthony-projects-sekhmet/a9b77064-2320-4f4e-aa20-5b8ec5d70377/scratchpad/critique/`:

- `bridge-live.js`: real YouTube page, extension copy, `RELOADS=2` reproduces
  proposal 5.
- `bridge-probe.js`: fake watch page, extension copy; `EXE=<chrome>` shows that
  Chrome ignores `--load-extension`; `RELOAD=1` shows content scripts stop after
  a reload.
- `base_fetch_context.cc`: the Chromium source quoted above.
- `gitblob/`: the blob-staging test for proposal 3.
- `errors.png`: the user's Errors-page screenshot, taken from the transcript.
