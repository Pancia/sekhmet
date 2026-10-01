// Entry point for openfront.io.
//
// index.js is YouTube's: it starts the downloader, the feeling tracker and the
// volume keys, none of which are loaded on this host. All openfront needs is the
// overlay engine, which finds its own config by location.host.
initializeOverlays();
