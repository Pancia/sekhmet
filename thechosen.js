// watch.thechosen.tv sits the episode sidebar ("Next Episode" and whatever
// follows it) in a column beside the player, where it takes width off the video
// and runs a couple of thousand pixels past the bottom of it. This stacks it
// underneath instead - the same thing the site's own layout does once the
// viewport is narrow enough, asked for at every width.
//
// Two CSS rules do the work; the JS only finds the element to hang them on.
// Nothing is moved in the DOM on purpose: the page is React, and reparenting a
// node it owns is how you earn a NotFoundError on its next render.
let initializeTheChosen = (function() {
    const {log} = initLogger("thechosen")

    const MARK = "sekhmetStack";                   // data-sekhmet-stack
    const MARKED_ROW = '[data-sekhmet-stack="row"]';

    // Backed off harder than the default: a page with no player polls for the
    // life of the tab (lib.js has no iteration cap), and nothing here is urgent.
    const POLL_CONFIG = { initialWait: 100, increaseAfter: 20, increaseBy: 1.5, maxWait: 5000 };

    function addGlobalStyle(css, id) {
        const head = document.head || document.getElementsByTagName('head')[0];
        if (!head || document.getElementById(id)) { return; }

        const style = document.createElement('style');
        style.id = id;
        style.textContent = css;
        head.appendChild(style);
    }

    // A column beside the video, as opposed to something drawn over it: the
    // player's own control bar is also a flex row with a child the <video> is not
    // inside, so the structural test alone matches it too. Sitting clear of the
    // video horizontally is what separates the two, and it is the same thing that
    // makes the sidebar worth moving in the first place - it is taking width.
    function isSideColumn(child, videoRect) {
        const rect = child.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) { return false; }
        return rect.left >= videoRect.right || rect.right <= videoRect.left;
    }

    // The layout is Tailwind utilities the whole way down - no id, no data
    // attribute, nothing stable to match on - so the shape is the hook instead:
    // walking up from the <video>, the two-column layout is the outermost flex
    // row with a column alongside the player. Outermost because the player is
    // full of flex rows of its own, and they are nearer.
    function findRow() {
        const video = document.querySelector("main video") || document.querySelector("video");
        if (!video) { return null; }

        // Before layout every rect is 0x0 and nothing can be told apart. Say so
        // and let the caller come back rather than guessing.
        const videoRect = video.getBoundingClientRect();
        if (videoRect.width <= 0 || videoRect.height <= 0) { return null; }

        let found = null;
        for (let node = video.parentElement; node && node !== document.body; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (!style.display.includes("flex")) { continue; }
            if (!style.flexDirection.startsWith("row")) { continue; }
            if (Array.from(node.children).some(child => !child.contains(video) && isSideColumn(child, videoRect))) {
                found = node;
            }
        }
        return found;
    }

    // Returns whether the page is one we have anything to do with - false covers
    // both "no player yet" and "already stacked by the site's own breakpoint",
    // which want the same answer: leave it alone.
    function apply() {
        const row = findRow();
        if (!row) { return false; }

        let changed = row.dataset[MARK] !== "row";
        row.dataset[MARK] = "row";

        const video = row.querySelector("video");
        const videoRect = video.getBoundingClientRect();
        for (const child of row.children) {
            if (child.contains(video) || !isSideColumn(child, videoRect)) { continue; }
            if (child.dataset[MARK] !== "aside") { changed = true; }
            child.dataset[MARK] = "aside";
        }

        if (changed) { log("stacked the episode sidebar below the player"); }
        return true;
    }

    let cancelWait = null;
    let lastUrl = null;

    function sync() {
        if (cancelWait) { cancelWait(); cancelWait = null; }
        if (apply()) { return; }

        // The route renders before the player mounts, so a fresh navigation
        // usually has nothing to find on the first pass.
        cancelWait = waitForElementToBeLoaded("main video", () => {
            cancelWait = null;
            apply();
        }, null, POLL_CONFIG);
    }

    function debounce(wait, func) {
        let timeout;
        return function() {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, arguments), wait);
        };
    }

    // There is no navigation event to hook, so this rides the DOM churn the way
    // loop.js and overlays.js do. Two things bring us back: a new URL, and our
    // mark going missing because React replaced the nodes under it.
    const recheck = debounce(150, function() {
        const navigated = location.href !== lastUrl;
        if (!navigated && document.querySelector(MARKED_ROW)) { return; }
        if (!navigated && cancelWait) { return; }   // a poll is already looking

        lastUrl = location.href;
        sync();
    });

    function initializeTheChosen() {
        addGlobalStyle(`
        /* The player/sidebar row, stacked. */
        ${MARKED_ROW} {
            flex-direction: column !important;
        }

        /* Its width came from being a column; below the video it gets the lot,
           and the cards inside keep the widths they were designed at. */
        [data-sekhmet-stack="aside"] {
            width: 100% !important;
            max-width: 100% !important;
        }
    `, 'sekhmet-thechosen-stack');

        lastUrl = location.href;
        sync();

        new MutationObserver(recheck).observe(document, {subtree: true, childList: true});
        log(`initialized for ${window.location.host}`);
    }

    return initializeTheChosen
})();

initializeTheChosen();
