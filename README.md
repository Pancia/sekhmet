# Sekhmet

Named for the Egyptian lioness goddess whose rampage was ended not by force but by
interruption: Ra poured out beer dyed red, she drank it and slept, and woke calm.
The gates here work the same way - not a block, but a pause long enough for the
reflex to wear off.

This browser extension works on Firefox, Brave, Chrome, and other Chromium-based browsers. Its original three features were ported from Greasemonkey scripts:

1. **Video Downloader**: Adds download buttons for YouTube videos in different formats
2. **Feeling Tracker**: Tracks YouTube watch time and periodically asks the user how they're feeling
3. **Content Overlays**: Creates overlays that hide YouTube content until users intentionally interact with them

## Gate wallpapers

The gates (the YouTube player, openfront.io) can show your own pictures instead of
plain black. Open the extension's options - right-click any page, **Gate
wallpapers…**, or the Details page on `brave://extensions` - and add images per
gate. One is picked at random each time a gate goes up. They are stored in the
browser, not in this repo.

## Element picker

Right-click anything, **Pick element to block…**. A panel shows the element's HTML
with hashed class names removed, and rules for uBlock Origin that would hide it,
each with how many elements it hides on the page. Arrow keys or the row of
element names move the selection; **+ Example** adds more elements the rule must
also cover. **Copy** puts `site##rule` on the clipboard for uBlock's My filters.

**Ask Claude** sends the trimmed HTML through the `com.sekhmet.picker_claude`
native host, which runs `~/dotfiles/bin/claude-p`. It only runs when pressed.
`test/picker-page.html` drives the picker in a real browser; see its header.

## Installation

### Firefox
1. Open Firefox and navigate to `about:debugging`
2. Click "This Firefox" in the sidebar
3. Click "Load Temporary Add-on"
4. Navigate to the extension directory and select `manifest.json`

### Brave / Chrome / Edge
1. Open your browser and navigate to the extensions page:
   - Brave: `brave://extensions`
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
2. Enable "Developer mode" (toggle in top-right corner)
3. Click "Load unpacked"
4. Select the extension directory

## Implementation Details

### Porting Process

1. Started by porting `ytdl.js` to `index.js`
2. Added `feeling-tracker.js` functionality to `index.js`
3. Split the monolithic `index.js` into separate modules:
   - Created standalone `ytdl.js` and `feeling-tracker.js` files
   - Updated `index.js` to be a thin coordinator
4. Ported `overlays.js` as a separate module
5. Updated `manifest.json` to load all scripts in the correct order

### Technical Changes

- Replaced jQuery with native JavaScript where possible
- Converted localStorage usage to WebExtension `browser.storage.local` API
- Added [Mozilla's webextension-polyfill](https://github.com/mozilla/webextension-polyfill) for cross-browser compatibility (Firefox/Chromium)
- Created a custom Cookies interface for browser storage
- Implemented the pressAndHold plugin natively
- Added proper async/await support for browser API calls

### Current Structure

- `polyfill.js`: Cross-browser API compatibility layer (Mozilla's webextension-polyfill)
- `lib.js`: Shared utilities and helpers
- `ytdl.js`: Video download functionality
- `feeling-tracker.js`: YouTube watch time tracking and mood prompts. A ring at the top middle of the player counts down the last 30 seconds of playing time before a prompt, and clicking it opens the prompt early
- `overlays.js`: Content overlay functionality
- `loop.js`: Per-video loop that survives reloads - toggled with `Shift+L` or from the 🧭 menu, where switching it on also offers start and end times to loop only part of the video (typed, clicked or dragged on a timeline, or taken from the playhead; the range holds only while playing, so a paused playhead can be dragged outside it to pick a new one, and it is ignored during ads). Stored permanently in `storage.local` under `sekhmet_loopedVideos` (clear it wholesale with `browser.storage.local.remove('sekhmet_loopedVideos')`, since there is no settings page yet)
- `youtube.js`: YouTube-specific functionality
- `google-it.js`: DuckDuckGo integration
- `openfront-gate.js`: Entry point for openfront.io - starts the overlay engine, which raises a 15s hold-to-play gate over the whole page. Only on the root page (a deeper path is a match already under way), and at most once every 5 minutes - clearing it is recorded in `storage.local` under `sekhmet_clearedGates` alongside the YouTube gates, with the cooldown set per-overlay by `clearedTtlMs`
- `openfront-block.js`: **Disabled** (not in the manifest). The previous approach: stopped openfront.io at `document_start` and asked the background script to reroute the tab
- `openfront-blocked.html` / `openfront-blocked.js`: The commitment reminder the block rerouted to - also unused while the block is off
- `thechosen.js`: watch.thechosen.tv - moves the episode sidebar ("Next Episode" and the rest of the column) from beside the player to below it. Finds the two-column layout by shape rather than by class name (the outermost flex row above the `<video>` that has a column the player is not in), tags it, and lets two CSS rules do the stacking - no DOM is reparented, because React owns those nodes. No-ops where the site's own breakpoint has already stacked the layout
- `allow-right-click.js`: Restores the native right-click menu on sites that suppress it (currently any host containing "solarmovie") by stopping `contextmenu` at window capture, before the page's own listeners see it. Add a site to both its `include_globs` in the manifest and `ALLOW_RIGHT_CLICK_HOSTS` in the script - the glob alone also lets the name through when it is only in the path
- `index.js`: Main coordinator script
- `background.js`: Background script for context menus and messaging
- `manifest.json`: Extension configuration

## Tests

Node-only, no dependencies and no `package.json` - run them with `cmds test`, or
`node test/run.js`. `cmds check` is the cheaper one: it parses every `.js` and
confirms every file `manifest.json` names actually exists, which is the failure
that once stopped the extension loading outright.

- `test/harness.js`: browser stubs - storage that can fail, a `<video>` YouTube
  reuses across navigation, media events that do not bubble, a driveable poller
- `test/loop.test.js`: one group per bug that was genuinely in `loop.js`
- `test/gate.test.js`: the overlay gates' cooldown, path and navigation rules,
  run against function bodies lifted out of `overlays.js` by name rather than
  copied - so a rename fails loudly instead of testing a stale duplicate

They stub the browser rather than drive one, so they cover decisions, not
rendering. Anything about how an overlay actually looks still needs the browser.

## Potential Next Steps

- Add support for other video platforms
- Implement a settings page to control features
- Fix any bugs or inconsistencies in the ported code
- Add proper error handling for browser API calls
