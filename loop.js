let YTELoop = (function() {
    const {log, debug, error} = initLogger("loop")

    // videoId -> remembered-at. Permanent on purpose: unlike overlays' cleared
    // gates, which age out so a video gets to ask again, a loop is a standing
    // instruction and going quiet after a month would just look like a bug.
    // There is no settings page yet, so the escape hatch is
    // browser.storage.local.remove('sekhmet_loopedVideos') from the console.
    const STORAGE_KEY = 'sekhmet_loopedVideos';

    // The in-memory copy is what everything actually reads: the compass menu
    // renders its rows synchronously and a keypress has to answer immediately.
    const remembered = new Map();

    let installed = false;
    // The key we last set video.loop for, and only ever a key we set ourselves.
    // YouTube carries one <video> across SPA navigation, so without this a
    // remembered video would leave the *next* one looping - see sync().
    let assertedFor = null;
    let lastKey = null;
    // Set by the first storage.onChanged, and checked before the hydration
    // snapshot is applied - see hydrated below.
    let storageChanged = false;
    let cancelPlayerWait = null;

    function storageUsable() {
        try {
            return !!(browser && browser.runtime && browser.runtime.id);
        } catch (e) {
            return false;
        }
    }

    // --- what we are pointing at -------------------------------------------------

    // Never cached, for the reason volume.js and feeling-tracker.js both document:
    // YouTube pools player elements and swaps them, so a stored reference goes
    // stale without ever looking stale.
    //
    // The fallback is scoped to a player root rather than left as a bare
    // `video.html5-main-video`, which the hover-preview player's video also
    // carries. During the window where #movie_player has no <video> yet, a hovered
    // sidebar thumbnail would otherwise be the first match, and looping the
    // preview is both invisible and permanent - nothing later resolves back to it
    // to clear the flag.
    function findMainVideo() {
        return document.querySelector('#movie_player video')
            || document.querySelector('.html5-video-player:not(#inline-preview-player) video.html5-main-video');
    }

    // Watch pages only. Shorts already loop by themselves, and a feed, a search or
    // a channel page has no single video for this to be about. Identity comes from
    // the URL rather than the element, because the same <video> is reused from one
    // video to the next and so cannot tell them apart.
    function videoIdFromUrl() {
        if (window.location.hostname !== 'www.youtube.com') return null;
        if (!window.location.pathname.includes('/watch')) return null;
        try {
            return new URLSearchParams(window.location.search).get('v');
        } catch (e) {
            return null;
        }
    }

    // Null means "nothing here to loop", which the compass menu turns into a
    // disabled button and an "n/a" row rather than an error.
    function currentKey() {
        const id = videoIdFromUrl();
        if (!id) return null;
        return findMainVideo() ? id : null;
    }

    function isRemembered() {
        const key = currentKey();
        return !!key && remembered.has(key);
    }

    // --- the registry ------------------------------------------------------------

    // Raw storage rather than lib.js's Cookies helper. Cookies.get swallows the
    // rejection and answers null for "never written" *and* for "the read failed"
    // (lib.js:491-497), and Cookies.set swallows write failures entirely - both
    // distinctions this has to make. feeling-tracker.js:14-41 takes the same route
    // for the same reason.
    function readRegistry() {
        return browser.storage.local.get(STORAGE_KEY).then(r => r[STORAGE_KEY] || {});
    }

    // Read-merge-write, seeded from the stored copy *and* the in-memory map, so
    // each tab re-contributes everything it knows. Two tabs toggling different
    // videos inside one round trip would otherwise both merge the same snapshot and
    // the later write would silently drop the earlier video. This narrows that
    // window rather than closing it - storage.local has no transaction - but a lost
    // update now needs the two writes to actually overlap, rather than merely a
    // slow read. overlays.js:817-830 merges the same way.
    //
    // Deleting is what makes "off" stick - an absent entry *is* the off state,
    // since there is no TTL here to age one out - and `remembered` has already had
    // the key removed by the time toggle() calls this.
    //
    // Resolves true only when the write actually landed, so toggle() can tell the
    // user when their choice is not going to outlive the page.
    function persist(key, on) {
        if (!storageUsable()) return Promise.resolve(false);

        return readRegistry().then(stored => {
            const merged = Object.assign({}, stored);
            remembered.forEach((at, k) => { merged[k] = at; });
            if (on) { merged[key] = Date.now(); } else { delete merged[key]; }
            return browser.storage.local.set({ [STORAGE_KEY]: merged });
        }).then(() => true).catch(err => {
            error(`could not persist the loop registry: ${err}`);
            return false;
        });
    }

    // Started at load rather than at first use, so the round trip to the background
    // page overlaps with the player setting itself up. Losing that race costs
    // nothing: a remembered video only needs its flag by the time it reaches the end.
    const hydrated = (storageUsable()
        ? readRegistry()
        : Promise.resolve(null)
    ).then(stored => {
        // If another tab has written since this read was issued, the snapshot in
        // hand predates that write. Applying it would re-add an entry that tab just
        // deleted, and nothing further would write to settle the disagreement.
        if (storageChanged) {
            debug('registry already refreshed by another tab, dropping the hydration snapshot');
            return;
        }
        Object.entries(stored || {}).forEach(([key, at]) => {
            if (typeof at === 'number') remembered.set(key, at);
        });
        log(`restored ${remembered.size} looped videos`);
    }).catch(err => {
        error(`could not read the loop registry: ${err}`);
    });

    // --- applying it -------------------------------------------------------------

    function sync() {
        const key = currentKey();
        const video = findMainVideo();
        // Nothing mounted yet. Leave assertedFor alone so the next sync - the new
        // video's loadstart, or the poll below - gets another go at it.
        if (!video) return;

        // Asserting the true side is unconditional: this is the switch the feature
        // exists to remember.
        if (key && remembered.has(key)) {
            if (!video.loop) video.loop = true;
            assertedFor = key;
            return;
        }

        // Past here the flag should be off, but only if it is ours to turn off. A
        // loop the user set through YouTube's own right-click menu is left alone.
        if (!assertedFor) return;

        // A null key is not evidence that our video went away. Clicking through to
        // the feed leaves the miniplayer playing the very same element, and
        // clearing there would stop a remembered video looping mid-watch with no
        // way to put it back - off a watch page both Shift+L and the compass button
        // are dead. Wait for a real new key instead; the next video's loadstart
        // clears it.
        if (!key) return;

        if (video.loop) video.loop = false;
        assertedFor = null;
    }

    function toggle() {
        const key = currentKey();
        if (!key) {
            debug('no video on this page to loop');
            return;
        }

        const on = !remembered.has(key);
        if (on) { remembered.set(key, Date.now()); } else { remembered.delete(key); }

        const video = findMainVideo();
        // The one place false gets forced regardless of who set it: the user just
        // asked for it, so this is not us overruling YouTube's menu behind their back.
        if (video) video.loop = on;
        assertedFor = on ? key : null;

        // Sticky until the write settles, then updated with the outcome. The flag
        // on the element is already set either way; what is still in doubt is
        // whether the choice outlives this page, and claiming "remembered" before
        // knowing that is the one thing this toast must not do. Storage answers in
        // single-digit milliseconds, so in practice it reads as a single toast.
        // The write is started before the toast, so a DOM problem raising out of
        // showToast cannot cost the user the setting itself.
        const pending = persist(key, on);
        const toast = showToast(
            on ? "🔁 Looping this video" : "Loop off for this video",
            { status: on ? "ok" : "info", timeout: 0 }
        );

        pending.then(written => {
            if (written) {
                toast.update(
                    on ? "🔁 Looping this video — remembered" : "Loop off for this video",
                    { status: on ? "ok" : "info", timeout: 2500 }
                );
                return;
            }
            // Usually means the extension was reloaded with this page still open,
            // which leaves storage unreachable from a content script that is
            // otherwise still running perfectly well.
            toast.update(
                on ? "🔁 Looping — this page only" : "Loop off — this page only",
                {
                    status: "error",
                    detail: "Couldn't save it; this won't survive a reload.",
                    timeout: 6000
                }
            );
        });

        log(`loop ${on ? 'on' : 'off'} for ${key}`);
    }

    // --- keys --------------------------------------------------------------------

    function onKeyDown(event) {
        if (!event.shiftKey) return;
        // "L" normally, "l" when caps lock is on as well.
        if (event.key !== 'L' && event.key !== 'l') return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        // Holding the key is one instruction, not thirty. Without this, autorepeat
        // fires ~30 toggles a second, each with its own unserialized read-merge-write,
        // and they commit out of order.
        if (event.repeat) return;
        if (event.isComposing || event.keyCode === 229) return;

        // Our own modals.
        if (document.getElementById('feeling-dialog')) return;
        if (document.getElementById('sekhmet-ft-status-menu-backdrop')) return;

        if (isTypingTarget(event)) return;

        // Off a watch page the key means nothing here, so leave it to the page.
        if (!currentKey()) return;

        // YouTube reads a bare "l" as seek-forward-10s without checking shift, so
        // the key has to be taken away from it rather than merely acted on.
        event.preventDefault();
        event.stopImmediatePropagation();

        toggle();
    }

    // --- staying in sync ---------------------------------------------------------

    // Media events do not bubble, but a capturing listener on document still sees
    // them on the way down to the target - which is what lets this survive YouTube
    // swapping the element out from under us.
    //
    // loadstart and loadedmetadata only. Both mean a source was (re)loaded, which
    // is the boundary a remembered loop should be re-applied at. canplay also fires
    // after every seek and every stall recovery, and re-asserting there would
    // silently undo YouTube's own Loop menu mid-playthrough - unticking it would
    // appear to do nothing on exactly the videos this feature owns.
    function watchMedia() {
        ['loadstart', 'loadedmetadata'].forEach(type => {
            document.addEventListener(type, event => {
                if (!(event.target instanceof HTMLVideoElement)) return;
                sync();
            }, true);
        });
    }

    // A direct load of a remembered watch page can beat the player: #movie_player
    // has no <video> yet, so the sync after hydration does nothing, and the media
    // events that would normally cover it have already fired. Every other module
    // here waits for the player rather than assuming it - overlays.js:1120,
    // and initializeFeelingTracker retries itself.
    //
    // Cancelled and restarted per navigation, because waitForElementToBeLoaded has
    // no iteration cap: one left running for a page we have left would poll for the
    // life of the tab.
    function waitForPlayer() {
        if (cancelPlayerWait) { cancelPlayerWait(); cancelPlayerWait = null; }
        if (!videoIdFromUrl()) return;   // nothing to wait for off a watch page
        if (findMainVideo()) return;

        cancelPlayerWait = waitForElementToBeLoaded('#movie_player video', () => {
            cancelPlayerWait = null;
            sync();
        });
    }

    // No navigation event to hook, so this rides the DOM churn like youtube.js
    // does. The href comparison comes first deliberately: this fires on every
    // mutation on a page that mutates constantly, and currentKey() is two
    // querySelectors that would otherwise run thousands of times a minute.
    function watchNavigation() {
        lastKey = videoIdFromUrl();
        let lastHref = window.location.href;

        new MutationObserver(() => {
            if (window.location.href === lastHref) return;
            lastHref = window.location.href;

            // The URL's own idea of identity, not currentKey(): that returns null
            // while the player is still mounting, so a feed -> watch navigation
            // would compare null to null, look like no change, and skip the wait
            // below - which is exactly the case the wait exists for. Comparing ids
            // also means a bare "&t=" stamp on the same video is correctly no
            // navigation at all.
            const key = videoIdFromUrl();
            if (key === lastKey) return;
            lastKey = key;
            sync();
            waitForPlayer();
        }).observe(document, { subtree: true, childList: true });
    }

    // Another tab toggling the same video should not leave this one's menu
    // claiming the opposite, and this settles the toggle-here/hydrate-there race
    // for free. Our own writes come back through here too, where they are no-ops.
    function watchStorage() {
        if (!storageUsable()) return;

        try {
            browser.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local' || !changes[STORAGE_KEY]) return;

                storageChanged = true;
                remembered.clear();
                Object.entries(changes[STORAGE_KEY].newValue || {}).forEach(([key, at]) => {
                    if (typeof at === 'number') remembered.set(key, at);
                });
                sync();
            });
        } catch (e) {
            debug('storage.onChanged unavailable', e);
        }
    }

    function init() {
        if (installed) return;   // index.js calls init() twice
        installed = true;

        // Window capture for the same reason volume.js uses it: it is the first
        // stop in the propagation path, ahead of both YouTube's own shortcuts and
        // the document-capture handler in youtube.js.
        window.addEventListener('keydown', onKeyDown, true);

        watchMedia();
        watchNavigation();
        watchStorage();

        hydrated.then(() => {
            sync();
            waitForPlayer();
        });
        log('per-video loop installed (Shift+L)');
    }

    return { init, currentKey, isRemembered, toggle };
})();
