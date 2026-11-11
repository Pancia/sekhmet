let PinterestPeek = (function() {
    // Pinterest: a pin stays veiled - a soft wash of its own colours - until it
    // has been wholly on screen once, then fades in and stays shown. Pinterest's
    // staggered columns end at a different height each, so there are always
    // half-pins peeking up from the bottom edge, pulling you to scroll on. With
    // those veiled, what you see in focus is only whole pins.
    //
    // Pinterest's grid itself is left alone: its pins keep their buttons, clicks
    // and loading. An earlier version redrew the grid as even rows from copies
    // of the pins, but Pinterest destroys pins it thinks are off screen, judged
    // by its own layout, so moved pins vanished and the copies had no buttons.
    // Marking a pin with an attribute changes nothing Pinterest relies on.
    // Two other ideas fail for related reasons. Pinterest places pins from
    // image sizes it stored, not from the DOM, so CSS cannot make even rows.
    // The grid sits in an overflow:hidden box, so CSS scroll-snap inside it
    // does not snap the page.
    const {log} = initLogger("pinterest")

    // Logged out every pin is a [data-grid-item="true"] straight under the
    // grid's list. Logged in is not something this could be tested against,
    // so both the item and its grid are matched loosely. pinterest.css holds
    // back the pictures of both kinds until they carry PIN, so every one this
    // matches must get PIN on the next pass, even when it is not used.
    const ITEM = '[data-grid-item]';
    const FALLBACK_ITEM = '[role="list"] > [role="listitem"]';
    const VEILED = 'data-sekhmet-veiled';
    // On every pin this has looked at: "off" in a grid without columns, else
    // "new" for its first frame and "ready" after. The fade is only animated
    // once ready, so a pin that arrives veiled starts veiled - it is never
    // seen and then covered.
    const PIN = 'data-sekhmet-pin';
    const MEDIA = 'data-sekhmet-media';
    const SRC = Symbol('veil source');
    const WIDE_ITEM = 1.5;     // wider than this many columns: a pin's own closeup, a module
    const TALL = 0.8;          // taller than this much of the window can never be whole

    // Pins already shown, for the life of the tab. Pinterest destroys and
    // rebuilds pin elements as you scroll, so this is by pin, not by element:
    // scrolling back up finds them shown, not veiled again.
    const revealed = new Set();

    // A pin is revealed once it is wholly inside the window. One that could
    // never fit, or a wide one (the opened pin on its own page), is shown at
    // once.
    function reveals(top, bottom, viewport, wide) {
        if (wide || bottom - top > viewport * TALL) { return true; }
        return top >= -0.5 && bottom <= viewport + 0.5;
    }

    // A pin is veiled until it has been revealed. An item with no key (no pin
    // link and no picture, such as a card of links) can never be revealed, so
    // it is never veiled: veiled items take no clicks.
    function veils(key, shown) {
        return !!key && !shown.has(key);
    }

    // What the eye sees of a pin: its largest image or video, rather than the
    // card, which can keep room for a title a filter has hidden. Largest,
    // because a card can also hold small ones (an avatar, a board icon).
    function mainMedia(item) {
        let best = null, area = 0;
        for (const el of item.querySelectorAll('img, video')) {
            const r = el.getBoundingClientRect();
            if (r.width * r.height > area) { best = el; area = r.width * r.height; }
        }
        return best;
    }

    // The box the picture sits in. The veil is drawn over it, and it is what
    // gets measured: the picture itself is faded by the veil, the box never
    // changes size or place.
    function mediaBox(item, media) {
        const box = media && media.parentElement;
        return box && box !== item && box.getBoundingClientRect().height > 0 ? box : null;
    }

    function mediaSrc(media) {
        return media && (media.currentSrc || media.getAttribute('src') || media.getAttribute('poster')) || null;
    }

    // Which pin this is, across rebuilds: its link if it has one (logged out
    // it does not), else its picture with the size folder taken out, since
    // the same picture comes as 236x, 474x and so on.
    function pinKey(item, src) {
        const href = item.querySelector('a[href*="/pin/"]')?.getAttribute('href');
        const m = href && href.match(/\/pin\/([^/?#]+)/);
        if (m) { return 'pin:' + m[1]; }
        return src ? 'img:' + src.replace(/\/\d+x\//, '/').replace(/\/originals\//, '/') : null;
    }

    // The veil is the pin's own picture, blurred into a wash of its colours, on
    // a pseudo-element over the box. It needs the picture's address and a
    // positioned box to sit in. Both are read before any writes: src, and
    // position, which is only read for a box not yet dressed.
    function dress(box, src, position) {
        if (!box.hasAttribute(MEDIA)) {
            box.setAttribute(MEDIA, position === 'static' ? 'static' : '');
        }
        if (src && box[SRC] !== src) {
            box[SRC] = src;
            box.style.setProperty('--sekhmet-veil', `url("${src.replace(/"/g, '%22')}")`);
        }
    }

    function gridOf(item) {
        return item.closest('[role="list"]') || item.parentElement;
    }

    function setAttr(el, name, value) {
        if (value === null) {
            if (el.hasAttribute(name)) { el.removeAttribute(name); }
        } else if (el.getAttribute(name) !== value) {
            el.setAttribute(name, value);
        }
    }

    let reported = null;

    function pass() {
        const viewport = innerHeight;
        let items = [...document.querySelectorAll(ITEM)];
        // Fallback items not used this pass: marked "off" below, so that the
        // stylesheet's hold lets their pictures show.
        let unused = [];
        if (items.length) {
            unused = [...document.querySelectorAll(`${FALLBACK_ITEM}:not([${PIN}])`)]
                .filter(el => !el.matches(ITEM));
        } else {
            items = [...document.querySelectorAll(FALLBACK_ITEM)];
        }

        // Per grid: its column width, and whether it has columns at all. A
        // single-column list has nothing staggered to hide.
        const grids = new Map();
        const rects = items.map(item => item.getBoundingClientRect());
        items.forEach((item, i) => {
            const list = gridOf(item);
            let g = grids.get(list);
            if (!g) { grids.set(list, g = { xs: new Set(), column: Infinity }); }
            const r = rects[i];
            if (r.width) {
                g.xs.add(Math.round(r.left));
                g.column = Math.min(g.column, r.width);
            }
        });

        // Read everything first, then write, so the page lays out once.
        const plans = items.map((item, i) => {
            const g = grids.get(gridOf(item));
            if (g.xs.size < 2) { return { off: true }; }
            const media = mainMedia(item);
            const box = mediaBox(item, media);
            const src = mediaSrc(media);
            const key = pinKey(item, src);
            const r = box ? box.getBoundingClientRect() : rects[i];
            const wide = rects[i].width > g.column * WIDE_ITEM;
            if (key && r.height > 0 && reveals(r.top, r.bottom, viewport, wide)) { revealed.add(key); }
            const position = box && !box.hasAttribute(MEDIA) ? getComputedStyle(box).position : null;
            return { box, src, position, veiled: veils(key, revealed) };
        });

        for (const el of unused) { el.setAttribute(PIN, 'off'); }

        const fresh = [];
        items.forEach((item, i) => {
            const plan = plans[i];
            if (plan.off) {
                setAttr(item, PIN, 'off');
                setAttr(item, VEILED, null);
                return;
            }
            if (!item.hasAttribute(PIN) || item.getAttribute(PIN) === 'off') {
                item.setAttribute(PIN, 'new');
                fresh.push(item);
            }
            if (plan.box) { dress(plan.box, plan.src, plan.position); }
            setAttr(item, VEILED, plan.veiled ? '' : null);
        });
        if (fresh.length) {
            requestAnimationFrame(() => requestAnimationFrame(() => fresh.forEach(item => {
                if (item.getAttribute(PIN) === 'new') { item.setAttribute(PIN, 'ready'); }
            })));
        }

        // Once per page, so a console shows whether pins were found at all.
        if (items.length && reported !== location.pathname) {
            reported = location.pathname;
            log(`${location.pathname}: ${items.length} pins in ${grids.size} grids, `
                + `${[...grids.values()].filter(g => g.xs.size >= 2).length} with columns`);
        }
    }

    let queued = false;
    function schedule() {
        if (queued) { return; }
        queued = true;
        requestAnimationFrame(() => { queued = false; pass(); });
    }

    function init() {
        log('Veiling pins until they are wholly on screen');
        new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        schedule();
    }

    return { init, reveals, veils };
})();

PinterestPeek.init();
