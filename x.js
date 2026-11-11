// x.com: the replies under a post get the YouTube comments treatment - blurred,
// each behind its own hold-to-reveal. The overlay engine does the gating; all
// this file does is decide which list entries are replies and tag them, because
// no static selector can say so for long.
//
// X serves two builds and both are live. Logged in it is the old React Native
// Web one - data-testid everywhere, and a virtualized list whose rows are
// absolutely positioned and get created and destroyed as you scroll. Logged
// out it is a newer Tailwind one with no test ids at all, just a <ul> under an
// id of "urt:conversation:<postId>". Each is matched separately below.
//
// "A reply" means "after the post you opened": a reply's own page lists its
// parent posts above it, and those stay readable. The obvious CSS for that -
// every row after the opened post's row - stops working the moment you scroll
// far enough for the list to throw that row away, and replies would un-blur.
// So rows are classified here as they arrive, and the verdict is kept per post
// id rather than per element.
const XReplies = (function() {
    const {log} = initLogger("x")

    const REPLY = 'sekhmet-x-reply';
    const STATUS_PAGE = /^\/[^/]+\/status\/\d+/;

    const BUILDS = [
        {
            // Logged in. Scoped by structure rather than by the list's
            // aria-label ("Timeline: Conversation"), which is translated.
            row: '[data-testid="primaryColumn"] section[role="region"] [data-testid="cellInnerDiv"]',
            // The opened post is the one article taken out of the tab order.
            opened: 'article[data-testid="tweet"][tabindex="-1"]',
            post: 'article[data-testid="tweet"]'
        },
        {
            // Logged out. Every reply is wrapped in a [role=link] to its own
            // page; the opened post is the one article that is not.
            row: '[id^="urt:conversation:"] > ul > li',
            opened: 'article:not([role="link"] article)',
            post: 'article'
        }
    ];

    // Ids the hold has cleared. For the life of the tab, not the page: going
    // into a reply and coming back should not ask again for what you already
    // chose to read.
    const revealed = new Set();

    // Per conversation, reset on navigation: the same post is a reply on one
    // page and the opened post on the next.
    let page = null;
    let replies = new Set();
    let notReplies = new Set();
    let openedY = null;

    // The row's own post id, from its timestamp link (logged in) or its
    // [role=link] wrapper (logged out). Both come before any quoted post
    // inside, so the first match is the row's own.
    function postId(row) {
        const link = row.querySelector('a[href*="/status/"]:has(> time)');
        const href = link
            ? link.getAttribute('href')
            : row.querySelector('[role="link"][data-href*="/status/"]')?.getAttribute('data-href');
        const m = href && href.match(/\/status\/(\d+)/);
        return m ? m[1] : null;
    }

    // Where the virtualized list put the row. Only the logged-in build has
    // this; the logged-out one is a plain list and returns null.
    function rowY(row) {
        const m = row.style.transform.match(/translateY\((-?[\d.]+)px\)/);
        return m ? parseFloat(m[1]) : null;
    }

    function classify(build, rows) {
        const openedIndex = rows.findIndex(row => row.querySelector(build.opened));

        // The opened post is on screen: document order is the truth, and what
        // it says is remembered for when the row is gone.
        if (openedIndex >= 0) {
            openedY = rowY(rows[openedIndex]);
            rows.forEach((row, i) => {
                const id = postId(row);
                if (!id) { return; }
                (i > openedIndex ? replies : notReplies).add(id);
            });
            return rows.filter((row, i) => i > openedIndex);
        }

        // Scrolled past it. A post seen earlier keeps its verdict; a new one
        // is placed against where the opened post sat.
        return rows.filter(row => {
            const id = postId(row);
            if (id && notReplies.has(id)) { return false; }
            if (id && replies.has(id)) { return true; }
            const y = rowY(row);
            return openedY !== null && y !== null && y > openedY;
        });
    }

    // Synchronous, from a MutationObserver, so a row is tagged before it is
    // first painted - and a revealed one comes back already revealed, with no
    // blurred frame while the engine's throttled pass catches up.
    function tag() {
        if (!STATUS_PAGE.test(location.pathname)) { return; }

        if (page !== location.pathname) {
            page = location.pathname;
            replies = new Set();
            notReplies = new Set();
            openedY = null;
        }

        for (const build of BUILDS) {
            const rows = Array.from(document.querySelectorAll(build.row))
                .filter(row => row.querySelector(build.post));
            if (!rows.length) { continue; }

            classify(build, rows).forEach(row => {
                row.classList.add(REPLY);
                const id = postId(row);
                if (id && revealed.has(id)) { row.classList.add('revealed'); }
            });
            return;
        }
    }

    // The engine's onReveal hook: the hold clears the post, not the element.
    function remember(row) {
        const id = postId(row);
        if (id) { revealed.add(id); }
    }

    function init() {
        log('Watching for replies');
        tag();
        new MutationObserver(tag).observe(document.documentElement, { childList: true, subtree: true });
    }

    return { init, remember, REPLY };
})();

// Entry point for x.com. Tagging first, so the engine's first pass already has
// replies to find.
XReplies.init();
initializeOverlays();
