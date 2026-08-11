# YouTube Tools Browser Extension

This browser extension works on Firefox, Brave, Chrome, and other Chromium-based browsers. It combines the functionality of three Greasemonkey scripts:

1. **Video Downloader**: Adds download buttons for YouTube videos in different formats
2. **Feeling Tracker**: Tracks YouTube watch time and periodically asks the user how they're feeling
3. **Content Overlays**: Creates overlays that hide YouTube content until users intentionally interact with them

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
- `feeling-tracker.js`: YouTube watch time tracking and mood prompts
- `overlays.js`: Content overlay functionality
- `youtube.js`: YouTube-specific functionality
- `google-it.js`: DuckDuckGo integration
- `openfront-block.js`: Stops openfront.io at `document_start` and asks the background script to reroute the tab
- `openfront-blocked.html` / `openfront-blocked.js`: The commitment reminder the tab is rerouted to
- `index.js`: Main coordinator script
- `background.js`: Background script for context menus and messaging
- `manifest.json`: Extension configuration

## Potential Next Steps

- Add support for other video platforms
- Implement a settings page to control features
- Fix any bugs or inconsistencies in the ported code
- Add proper error handling for browser API calls
