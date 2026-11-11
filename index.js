function init() {
    // The pill and its greyed placeholders go up first, so the buttons keep
    // their places however late each module fills its own.
    if (window.location.hostname === "www.youtube.com") {
        waitForElementToBeLoaded("#center.ytd-masthead", mastheadPill, null, { initialWait: 20 });
    }
    initializeYTDL();
    initializeOverlays();
    initializeYoutube();
    initializeVolume();
    YTELoop.init();
    AskAi.init();
    setTimeout(() => {
        initializeFeelingTracker();
    }, 2000);
}

document.addEventListener("DOMContentLoaded", init);
// Also run init in case the page is already loaded
init();
