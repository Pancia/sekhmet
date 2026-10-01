let initializeVolume = (function() {
    const {log, debug, error} = initLogger("volume")

    // Volume stops, in YouTube's own 0-100 units. Hand-tuned for precision at the
    // quiet end — 5 to 10 doubles the amplitude, while 90 to 95 is barely audible —
    // with a deliberate cap of 5 on the largest step. This is the only thing to
    // edit to reshape the curve; the stepping code just needs it sorted ascending.
    const LADDER = [0, 1, 2, 3, 4, 5, 7, 9, 11, 13, 15, 20, 25, 30, 35,
                    40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];

    const REPEAT_MS = 60;   // floor between steps while a key is held (~16/s)
    const HUD_MS = 900;     // how long the readout lingers after the last press

    // Roles where the arrows already mean something — menus, listboxes, the search
    // suggestion dropdown. Deliberately no "slider": YouTube's volume panel is one
    // and takes focus after a click on the mute button, and bailing there would
    // make the feature look like it randomly stops working.
    const WIDGET_ROLES = '[role="textbox"],[role="combobox"],[role="listbox"],' +
        '[role="menu"],[role="menuitem"],[role="option"],[role="spinbutton"],' +
        '[role="tree"],[role="grid"]';

    let installed = false;
    let lastStepAt = 0;
    let hud = null;
    let hudLabel = null;
    let hudFill = null;
    let hudTimer = null;

    // --- reaching the player API -------------------------------------------------

    // Firefox hands content scripts the page's own objects through wrappedJSObject.
    // Chromium (so Brave) has no equivalent, and the player's API methods are
    // invisible from the isolated world there — hence player-bridge.js.
    function needsBridge() {
        return typeof window.wrappedJSObject === 'undefined';
    }

    function injectBridge() {
        try {
            const script = document.createElement('script');
            script.src = browser.runtime.getURL('player-bridge.js');
            script.onload = () => script.remove();
            (document.head || document.documentElement).appendChild(script);
        } catch (e) {
            error('could not inject the player bridge', e);
        }
    }

    function directApi(root) {
        const page = root.wrappedJSObject || root;
        if (typeof page.getVolume !== 'function' || typeof page.setVolume !== 'function') {
            return null;
        }
        return page;
    }

    // Returns null until the player API is reachable — before the bridge's first
    // mirror, or on a player that has not finished setting itself up.
    function readState(root) {
        const api = directApi(root);
        if (api) {
            try {
                return {
                    volume: Math.round(api.getVolume()),
                    muted: typeof api.isMuted === 'function' && api.isMuted()
                };
            } catch (e) {
                return null;
            }
        }
        const volume = root.getAttribute('data-sekhmet-vol');
        if (volume === null) return null;
        return {
            volume: Number(volume),
            muted: root.getAttribute('data-sekhmet-muted') === '1'
        };
    }

    function writeState(root, volume, unmute) {
        const api = directApi(root);
        if (api) {
            try {
                // setVolume does not unmute on its own.
                if (unmute && typeof api.unMute === 'function') api.unMute();
                api.setVolume(volume);
            } catch (e) {
                error('setVolume failed', e);
            }
            return;
        }
        root.dispatchEvent(new CustomEvent('sekhmet-volume-cmd', {
            bubbles: true,
            detail: JSON.stringify({ volume: volume, unmute: !!unmute })
        }));
    }

    // --- what we are pointing at -------------------------------------------------

    function isVisible(el) {
        return !!el && el.offsetWidth > 0 && el.offsetHeight > 0;
    }

    // Resolved fresh on every keypress, never cached: YouTube keeps a pool of
    // player elements and swaps them across navigation, so a stored reference goes
    // stale without ever looking stale. feeling-tracker.js:314-338 hit the same trap.
    //
    // Scoping to a player *root* is also what keeps the hover-preview player out —
    // #inline-preview-player is never inside #movie_player — and picks up the ad
    // player for free, since that lives inside the same root.
    function getPlayerRoot() {
        // Measure rather than trust an attribute: which of `active` / `enabled`
        // marks an open miniplayer varies by build, so ask whether there is a
        // player here taking up space instead. The miniplayer reuses the main
        // player element and moves it into this host — but not on every build,
        // hence the second branch.
        const mini = document.querySelector('ytd-miniplayer');
        if (mini) {
            const miniPlayer = mini.querySelector('.html5-video-player');
            if (isVisible(miniPlayer)) return miniPlayer;
            if (isVisible(mini)) {
                const main = document.getElementById('movie_player');
                if (isVisible(main)) return main;
            }
        }

        const path = window.location.pathname;
        if (path.startsWith('/shorts')) {
            return document.querySelector('ytd-reel-video-renderer[is-active] .html5-video-player')
                || document.getElementById('shorts-player')
                || document.getElementById('movie_player');
        }
        if (path.startsWith('/watch')) {
            return document.getElementById('movie_player');
        }
        // Feeds, search, channel pages: leave the arrows alone so the page scrolls.
        return null;
    }

    // YouTube's settings and quality menus drive themselves with the arrows.
    // Closed popups are display:none, so they measure zero.
    function isPopupOpen(root) {
        return Array.from(root.querySelectorAll('.ytp-popup')).some(p => p.offsetHeight > 0);
    }

    // --- the ladder --------------------------------------------------------------

    // Strictly-greater / strictly-less is the whole trick: it needs no special case
    // for a volume that is not on a stop. Dragged the slider to 37? Up gives 40,
    // down gives 35.
    function stepFrom(volume, direction) {
        if (direction > 0) {
            for (let i = 0; i < LADDER.length; i++) {
                if (LADDER[i] > volume) return LADDER[i];
            }
            return LADDER[LADDER.length - 1];
        }
        for (let i = LADDER.length - 1; i >= 0; i--) {
            if (LADDER[i] < volume) return LADDER[i];
        }
        return LADDER[0];
    }

    function step(root, state, direction) {
        // ArrowUp out of mute restores the level you left without also stepping:
        // one press to come back, the next to move. (Unless there is nothing to
        // come back to, in which case it steps off zero.)
        if (direction > 0 && state.muted) {
            const restored = state.volume > 0 ? state.volume : stepFrom(0, 1);
            writeState(root, restored, true);
            showHud(root, restored, false);
            return;
        }

        // Stepping down while muted moves the underlying level and stays muted, so
        // unmuting later puts you back where you left off. Reaching 0 deliberately
        // does not auto-mute — 0 is already silent, and flipping YouTube's mute
        // icon on its own would be surprising.
        const next = stepFrom(state.volume, direction);
        writeState(root, next, false);
        showHud(root, next, state.muted);
    }

    // --- readout -----------------------------------------------------------------

    // Bespoke rather than lib.js's showToast: that creates a node per call and its
    // handle goes inert once dismissed, neither of which survives a 16Hz readout,
    // and it is anchored to the top-right of the viewport where ytdl's toasts live.
    function ensureHud() {
        if (hud) return hud;

        hud = document.createElement('div');
        hud.id = 'ytvol-hud';
        hud.setAttribute('aria-hidden', 'true');
        Object.assign(hud.style, {
            position: 'absolute',
            top: '10%',
            left: '24px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '10px 16px',
            borderRadius: '10px',
            backgroundColor: 'rgba(0, 0, 0, 0.72)',
            // Gold, matching the gate's ring: a dark box alone was easy to miss
            // over a dark scene.
            border: '2px solid #f5c94a',
            boxShadow: '0 0 12px rgba(245, 201, 74, 0.45)',
            color: '#fff',
            fontFamily: 'Roboto, Arial, sans-serif',
            opacity: '0',
            pointerEvents: 'none',
            transition: 'opacity 0.18s ease',
            zIndex: '2147483000'
        });

        hudLabel = document.createElement('span');
        Object.assign(hudLabel.style, {
            fontSize: '28px',
            fontWeight: '500',
            lineHeight: '1',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums'
        });

        const track = document.createElement('div');
        Object.assign(track.style, {
            width: '120px',
            height: '4px',
            borderRadius: '2px',
            backgroundColor: 'rgba(255, 255, 255, 0.3)',
            overflow: 'hidden'
        });

        hudFill = document.createElement('div');
        Object.assign(hudFill.style, {
            height: '100%',
            width: '0%',
            backgroundColor: '#fff',
            transition: 'width 0.1s ease'
        });

        track.appendChild(hudFill);
        hud.appendChild(hudLabel);
        hud.appendChild(track);
        return hud;
    }

    function showHud(root, volume, muted) {
        const el = ensureHud();

        // Re-parent on every show (a no-op once it is already there). The player
        // root is inside whatever element YouTube fullscreens, whereas a
        // fixed-position node on document.body would sit under the fullscreen
        // backdrop, which paints opaque black and cannot be z-indexed past. It also
        // means the readout follows the player across SPA navigation, the
        // miniplayer, and Shorts reel changes for free.
        if (el.parentElement !== root) root.appendChild(el);

        hudLabel.textContent = muted ? '\u{1F507} ' + volume : String(volume);
        // Square-root fill, so the crowded low end of the ladder still moves the
        // bar visibly instead of sitting pinned at the left edge.
        hudFill.style.width = (muted ? 0 : Math.sqrt(volume / 100) * 100) + '%';
        hudFill.style.backgroundColor = muted ? 'rgba(255, 255, 255, 0.4)' : '#fff';

        el.style.opacity = '1';
        clearTimeout(hudTimer);
        hudTimer = setTimeout(() => { el.style.opacity = '0'; }, HUD_MS);
    }

    // --- keys --------------------------------------------------------------------

    function onKeyDown(event) {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        // Shift+Arrow is left alone on purpose: it is the escape hatch for scrolling
        // the watch page now that the bare arrows no longer do.
        if (event.shiftKey) return;
        if (event.isComposing || event.keyCode === 229) return;

        // Our own modals.
        if (document.getElementById('feeling-dialog')) return;
        if (document.getElementById('sekhmet-ft-status-menu-backdrop')) return;

        if (isTypingTarget(event)) return;
        const active = deepActiveElement();
        if (active && active.closest && active.closest(WIDGET_ROLES)) return;

        const root = getPlayerRoot();
        if (!root) return;
        if (isPopupOpen(root)) return;

        // Read before claiming the key rather than after. If the API is out of
        // reach — the bridge failed to inject, or the player has not finished
        // setting itself up — swallowing the arrows would leave the page with no
        // volume control *and* no scrolling. Letting them through is the better
        // failure.
        const state = readState(root);
        if (!state) {
            debug('player API not reachable, leaving the arrows alone');
            return;
        }

        // Past here the key is ours, repeats included. preventDefault has to happen
        // before the throttle: a repeat we chose to skip would otherwise fall
        // through to the browser and scroll the page mid-hold.
        event.preventDefault();
        event.stopImmediatePropagation();

        const now = performance.now();
        if (now - lastStepAt < REPEAT_MS) return;
        lastStepAt = now;

        step(root, state, event.key === 'ArrowUp' ? 1 : -1);
    }

    function initializeVolume() {
        if (installed) return;   // index.js calls init() twice
        installed = true;

        if (needsBridge()) injectBridge();

        // Window capture is the first stop in the propagation path, which is what it
        // takes to get in front of both YouTube's own 5% volume shortcut and the
        // document-capture handler in youtube.js.
        window.addEventListener('keydown', onKeyDown, true);
        log('arrow-key volume control installed');
    }

    return initializeVolume
})();
