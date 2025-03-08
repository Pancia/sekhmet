function init() {
    initializeYTDL();
    initializeOverlays();
    initializeYoutube();
    setTimeout(() => {
        initializeFeelingTracker();
    }, 2000);
}

document.addEventListener("DOMContentLoaded", init);
// Also run init in case the page is already loaded
init();
