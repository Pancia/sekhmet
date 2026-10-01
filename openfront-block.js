// Hard block for openfront.io. DISABLED - not in the manifest.
//
// Superseded by the page-wide gate in overlays.js: a 15s hold instead of a wall.
// Kept, along with openfront-blocked.html/.js and the "openfrontBlocked" branch
// in background.js, because turning it back on is one manifest entry - swap the
// openfront content script's js/run_at/all_frames back to what the block below
// documents.
//
// Runs at document_start, before the page has parsed a single tag: kill the
// load, then hand off to the background script to reroute the tab to the
// reminder page. Nothing from the site ever executes.
//
// An earlier version rebuilt the reminder inline by swapping out
// document.documentElement. The DOM came out correct — every node was
// queryable — but Firefox painted a bare grey window, because tearing out the
// root element after window.stop() leaves the document with no root frame to
// render. A real extension page sidesteps the whole problem.
//
// Deliberately self-contained: lib.js runs initPressAndHoldPlugin() at load,
// which touches the DOM, and there is no DOM here yet.
(function () {
    const prefix = "[YT+] [openfront]:";
    const log = (...args) => console.log(prefix, ...args);

    window.stop();
    log("stopped", location.href);

    // Subframes: stopping the load is the whole job. Only the top-level frame
    // asks for the reroute, or an embedded copy would navigate the tab.
    if (window.top !== window) return;

    browser.runtime.sendMessage({ action: "openfrontBlocked" })
        .catch(err => console.error(prefix, "could not reroute", err));
})();
