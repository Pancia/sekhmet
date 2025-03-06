# YouTube Tools Firefox Extension

This Firefox extension combines the functionality of three Greasemonkey scripts:

1. **Video Downloader**: Adds download buttons for YouTube videos in different formats
2. **Feeling Tracker**: Tracks YouTube watch time and periodically asks the user how they're feeling
3. **Content Overlays**: Creates overlays that hide YouTube content until users intentionally interact with them

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
- Converted localStorage usage to Firefox's WebExtension `browser.storage.local` API
- Created a custom Cookies interface for browser storage
- Implemented the pressAndHold plugin natively
- Added proper async/await support for browser API calls

### Current Structure

- `ytdl.js`: Video download functionality
- `feeling-tracker.js`: YouTube watch time tracking and mood prompts
- `overlays.js`: Content overlay functionality
- `index.js`: Main coordinator script
- `manifest.json`: Extension configuration

## Potential Next Steps

- Add support for other video platforms
- Implement a settings page to control features
- Fix any bugs or inconsistencies in the ported code
- Add proper error handling for browser API calls
