let initializeFeelingTracker = (function() {
    const {log, debug, error} = initLogger("YTFT")

    // Helper to check if extension context is still valid
    function isExtensionContextValid() {
        try {
            return !!(browser && browser.runtime && browser.runtime.id);
        } catch (e) {
            return false;
        }
    }

    // Safe wrapper for storage.get that checks context validity
    function safeStorageGet(key) {
        if (!isExtensionContextValid()) {
            debug('Extension context invalidated, cannot access storage');
            return Promise.resolve({});
        }
        return browser.storage.local.get(key).catch(err => {
            if (err.message && err.message.includes('Extension context invalidated')) {
                debug('Extension context invalidated during storage.get');
            } else {
                error(`Error accessing storage: ${err}`);
            }
            return {};
        });
    }

    // Safe wrapper for storage.set that checks context validity
    function safeStorageSet(data) {
        if (!isExtensionContextValid()) {
            debug('Extension context invalidated, cannot write to storage');
            return Promise.resolve();
        }
        return browser.storage.local.set(data).catch(err => {
            if (err.message && err.message.includes('Extension context invalidated')) {
                debug('Extension context invalidated during storage.set');
            } else {
                error(`Error writing to storage: ${err}`);
            }
        });
    }

    const CHECK_INTERVAL_MINUTES = 7.5;
    const SESSION_TIMEOUT_MINUTES = 5;
    const PAUSE_ENFORCER_MS = 100;
    const STORAGE_KEY_PLAYTIME = 'ytf_accumulatedPlayTime';
    const STORAGE_KEY_LASTACTIVE = 'ytf_lastActiveTime';
    // Per-tab enable flag, held in the tab's own sessionStorage rather than in
    // storage.local under a tab-id-derived key.
    //
    // Tab ids are documented as unique only "within a browser session", while
    // storage.local persists indefinitely — so ids get reused across restarts
    // and the flag detaches from the tab that set it: a disabled tab comes back
    // enabled, and an unrelated new tab can inherit the dead flag and start
    // disabled. Anything that closes and reopens a tab (some memory savers do)
    // has the same effect within a session.
    //
    // sessionStorage is per-tab by construction and survives reloads and
    // same-tab navigation. Session restore preserves it too, though that is
    // best-effort: it is subject to browser.sessionstore.dom_storage_limit and
    // only applies when a session is actually restored. Note that duplicating a
    // tab copies sessionStorage, so a duplicate of a disabled tab starts
    // disabled.
    const SESSION_KEY_ENABLED = 'ytf_feelingTracker_enabled';
    const STORAGE_KEY_MIGRATED = 'ytf_legacyEnabledMigrated';

    let checkIntervalMs = CHECK_INTERVAL_MINUTES * 60 * 1000;
    let sessionTimeoutMs = SESSION_TIMEOUT_MINUTES * 60 * 1000;
    let checkTimer = null;
    let sessionTimer = null;
    let videoElement = null;
    let lastPlayTimestamp = null;
    let accumulatedPlayTime = 0;
    let lastActiveTime = 0;
    let currentTabId = null;
    // initializeFeelingTracker is re-entrant — the retry loop and the SPA
    // watcher both call it again — so anything that attaches a listener or
    // starts a timer needs to know whether it already ran.
    let trackingActive = false;
    let listenedVideoElement = null;
    let visibilityListenerInstalled = false;
    let spaObserver = null;
    let retryTimer = null;

    // Get the current tab ID on initialization
    if (isExtensionContextValid()) {
        browser.runtime.sendMessage({ action: "getTabId" })
            .then(response => {
                currentTabId = response.tabId;
                log(`Got current tab ID: ${currentTabId}`);
                migrateLegacyEnabledFlag(currentTabId);
            })
            .catch(err => {
                if (err.message && err.message.includes('Extension context invalidated')) {
                    debug('Extension context invalidated during tab ID request');
                } else {
                    error(`Error getting tab ID: ${err}`);
                }
            });
    } else {
        debug('Extension context invalid, cannot get tab ID');
    }

    // Mirrors the sessionStorage value; used only if sessionStorage is
    // unreachable (blocked site data), so a toggle still holds for the
    // lifetime of the page.
    let enabledFallback = true;

    function readEnabled() {
        try {
            const raw = window.sessionStorage.getItem(SESSION_KEY_ENABLED);
            if (raw !== null) {
                // Keep the mirror current, so if sessionStorage starts throwing
                // later in the session we fall back to the real value rather
                // than to a stale default that would re-enable the tracker.
                enabledFallback = raw !== 'false';
                return enabledFallback;
            }
        } catch (err) {
            debug(`sessionStorage unavailable for read: ${err}`);
        }
        return enabledFallback;
    }

    function writeEnabled(value) {
        enabledFallback = value;
        try {
            window.sessionStorage.setItem(SESSION_KEY_ENABLED, String(value));
        } catch (err) {
            debug(`sessionStorage unavailable for write: ${err}`);
        }
    }

    // One-time upgrade path off the old tab-id-keyed flags. This tab's flag is
    // carried over if it is still findable under the current id; every other
    // key matching the legacy shape is unreachable once nothing reads them, so
    // they are dropped and the accumulated orphans drain on first run.
    //
    // Enumerating is what makes the cleanup possible — it does not widen the
    // migration. If this tab's id already changed, nothing recorded which dead
    // id belonged to it, so that flag is simply unrecoverable.
    //
    // Every YouTube tab runs this on load and the first to finish clears the
    // set for all of them, so a tab that loses the race skips its own
    // migration. That only bites during the single upgrade window and degrades
    // to the previous behaviour, which is why it is left alone.
    const LEGACY_ENABLED_KEY = /^ytf_feelingTracker_enabled_\d+$/;

    function migrateLegacyEnabledFlag(tabId) {
        // Cheap single-key check first: get(null) clones the whole of
        // storage.local across process boundaries, and this runs on every
        // YouTube page load for the life of the extension.
        safeStorageGet(STORAGE_KEY_MIGRATED).then(flag => {
            if (flag[STORAGE_KEY_MIGRATED]) return;
            if (!isExtensionContextValid()) return;

            // Deliberately not safeStorageGet: it reports a failed read as {},
            // which is indistinguishable from empty storage and would let us
            // record the migration as done having read nothing — stranding
            // every legacy flag permanently. A failed read must retry later.
            return browser.storage.local.get(null).then(all => {
                const legacyKeys = Object.keys(all).filter(key => LEGACY_ENABLED_KEY.test(key));

                // Re-checked after the round trip rather than before it: a
                // toggle may have landed while storage was in flight, and a
                // deliberate user choice has to win over the migrated value.
                let alreadySet;
                try {
                    alreadySet = window.sessionStorage.getItem(SESSION_KEY_ENABLED) !== null;
                } catch (err) {
                    debug(`sessionStorage unavailable, skipping migration: ${err}`);
                    return;
                }

                const ownKey = `${SESSION_KEY_ENABLED}_${tabId}`;
                if (!alreadySet && all[ownKey] === false) {
                    writeEnabled(false);
                    log(`Migrated legacy disabled flag for tab ${tabId} into sessionStorage`);
                    updateStatusButton();
                }

                if (!isExtensionContextValid()) return;
                return browser.storage.local.set({ [STORAGE_KEY_MIGRATED]: true })
                    .then(() => legacyKeys.length ? browser.storage.local.remove(legacyKeys) : null)
                    .then(() => {
                        if (legacyKeys.length) log(`Removed ${legacyKeys.length} legacy enable key(s)`);
                    })
                    .catch(err => debug(`Legacy key cleanup failed: ${err}`));
            });
        }).catch(err => debug(`Legacy flag migration failed: ${err}`));
    }

    // Kept promise-returning so the existing call sites read unchanged. The
    // read underneath is synchronous, which also closes the old startup race
    // where a not-yet-resolved tab id fell back to a global storage key.
    function isEnabled() {
        return Promise.resolve(readEnabled());
    }

    function toggleEnabled() {
        const newState = !readEnabled();
        writeEnabled(newState);
        log(`Feeling tracker is now ${newState ? 'enabled' : 'disabled'} for this tab`);

        if (!newState) {
            const dialog = document.getElementById('feeling-dialog');
            if (dialog) dialog.remove();
            stopPauseEnforcer();
            lastPlayTimestamp = null;
        }
        updateStatusButton();
    }

    function getStoredValue(key, defaultValue) {
        return safeStorageGet(key)
            .then(result => {
                return result[key] !== undefined ? JSON.parse(result[key]) : defaultValue;
            })
            .catch(err => {
                error(`Error getting stored value: ${err}`);
                return defaultValue;
            });
    }

    // Helper function to set values in browser storage
    function setStoredValue(key, value) {
        let data = {};
        data[key] = JSON.stringify(value);
        return safeStorageSet(data)
            .catch(err => {
                error(`Error setting stored value: ${err}`);
            });
    }

    // Function to check if session has timed out
    function checkSessionTimeout() {
        getStoredValue(STORAGE_KEY_LASTACTIVE, 0).then(storedLastActiveTime => {
            lastActiveTime = storedLastActiveTime;
            const currentTime = Date.now();
            const timeSinceLastActive = currentTime - lastActiveTime;

            if (lastActiveTime > 0 && timeSinceLastActive > sessionTimeoutMs) {
                log(`Session timeout: ${Math.round(timeSinceLastActive / 1000)} seconds since last activity, resetting accumulated time`);
                accumulatedPlayTime = 0;
                setStoredValue(STORAGE_KEY_PLAYTIME, 0);
            }
        });
    }

    function onVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            // Page is hidden (user switched tabs, etc.)
            if (lastPlayTimestamp) {
                const currentTime = Date.now();
                const additionalTime = currentTime - lastPlayTimestamp;
                accumulatedPlayTime += additionalTime;
                setStoredValue(STORAGE_KEY_PLAYTIME, accumulatedPlayTime);
                lastPlayTimestamp = null;
                log(`Page hidden. Updated accumulated play time: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
            }
        } else {
            // Page is visible again - refresh from storage
            getStoredValue(STORAGE_KEY_PLAYTIME, 0).then(storedTime => {
                accumulatedPlayTime = storedTime;
                log(`Page visible again. Refreshed accumulated play time: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
            });
        }
    }

    // Function to update last active time
    function updateLastActiveTime() {
        const currentTime = Date.now();
        lastActiveTime = currentTime;
        setStoredValue(STORAGE_KEY_LASTACTIVE, currentTime);
    }

    // Content scripts inject once per document load, so a tab that opened on
    // the homepage, search results or a channel page would take the early
    // return in initializeFeelingTracker and never track anything, however many
    // videos were watched in it afterwards — YouTube reaches them by SPA
    // navigation, not a new document. Watch for the path becoming /watch and
    // initialize then. youtube.js and overlays.js already do this for their own
    // features; the raw pathname compare matches youtube.js rather than
    // duplicating the debounce helper that is private to overlays.js.
    function watchForSpaNavigation() {
        // trackingActive is checked as well as spaObserver: once tracking has
        // started the observer is disconnected and nulled, and a pending retry
        // re-entering here would otherwise arm a fresh one that can never act.
        if (spaObserver || trackingActive) return;

        let lastPath = window.location.pathname;
        spaObserver = new MutationObserver(() => {
            if (window.location.pathname === lastPath) return;
            lastPath = window.location.pathname;

            // Already-running trackers survive SPA navigation on their own, so
            // this only has to catch the first arrival on a watch page.
            if (isWatchPage() && !trackingActive) {
                log(`Navigated to ${lastPath}, starting tracker`);
                initializeFeelingTracker();
            }
        });
        spaObserver.observe(document, { subtree: true, childList: true });
    }

    // The message listener is installed on every YouTube page, so anything that
    // touches the video or the accumulator has to ask separately.
    function isWatchPage() {
        return window.location.hostname === "www.youtube.com"
            && window.location.pathname.includes("/watch");
    }

    // A watch page can have several <video> elements mounted at once — the
    // hover-preview player carried over from a feed, an ad player, a Shorts
    // player. A bare querySelector('video') takes whichever comes first in
    // document order, which mid-navigation is frequently not the real one, and
    // binding to a stray leaves the tracker running against something that
    // never plays. Ask for the main player specifically and let the caller
    // retry if it hasn't rendered yet, rather than latching onto a stand-in.
    function findMainVideo() {
        return document.querySelector('#movie_player video')
            || document.querySelector('video.html5-main-video');
    }

    function getLiveVideoElement() {
        // YouTube is a SPA — the cached videoElement can become stale or
        // disconnected after navigation, and it can also still be mounted while
        // no longer being the main player, which isConnected alone won't catch.
        // The live main player is authoritative whenever there is one.
        const main = findMainVideo();
        if (main) {
            videoElement = main;
        } else if (videoElement && !videoElement.isConnected) {
            videoElement = null;
        }
        return videoElement;
    }

    async function showFeelingTrackerDialog({ debug: isDebug = false } = {}) {
        // Guarded here rather than at each caller: the status menu's debug
        // button is built on every YouTube page and reached this directly.
        // Completing the dialog runs trackFeeling(), which zeroes the *global*
        // playtime and watchedVideos keys — so a debug click on the homepage
        // would wipe a real in-progress session belonging to another tab.
        if (!isWatchPage()) {
            log('Ignoring feeling dialog request: not a watch page');
            return;
        }

        const v = getLiveVideoElement();
        if (v && !v.paused) {
            v.pause();
        }

        let d = document.getElementById('feeling-dialog')
        if (d) { return }

        startPauseEnforcer();

        const dialog = document.createElement('div');
        dialog.id = 'feeling-dialog';
        dialog.style.position = 'fixed';
        dialog.style.top = '50%';
        dialog.style.left = '50%';
        dialog.style.transform = 'translate(-50%, -50%)';
        dialog.style.backgroundColor = 'white';
        dialog.style.padding = '20px';
        dialog.style.borderRadius = '8px';
        dialog.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.2)';
        dialog.style.zIndex = '9999';
        dialog.style.width = '300px';
        dialog.style.textAlign = 'center';

        dialog.innerHTML = `
      <h2 style="margin-top: 0; color: #333;">How are you feeling?</h2>
      <p style="color: #666;">Check in with yourself after watching for a while.</p>
      <div style="display: flex; justify-content: space-between; margin-top: 20px;">
        <button id="feeling-worse" style="flex: 1; margin: 0 5px; padding: 10px; background-color: #F44336; color: white; border: none; border-radius: 4px; cursor: pointer;">Worse</button>
        <button id="feeling-neutral" style="flex: 1; margin: 0 5px; padding: 10px; background-color: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer;">Neutral</button>
        <button id="feeling-better" style="flex: 1; margin: 0 5px; padding: 10px; background-color: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;">Better</button>
      </div>
    `;

        document.body.appendChild(dialog);

        let holdTime = isDebug ? 1000 : 10000;
        let sharedProgress = { accumulated: 0 };

        let better = document.getElementById('feeling-better');
        let neutral = document.getElementById('feeling-neutral');
        let worse = document.getElementById('feeling-worse');
        let buttons = [better, neutral, worse];

        // When a button is clicked, hide progress bars on the other buttons
        function resetSiblingBars(activeButton) {
            for (const btn of buttons) {
                if (btn !== activeButton) {
                    const bar = btn.querySelector('.holdButtonProgress');
                    if (bar) bar.style.left = '-100%';
                }
            }
        }

        const holdOpts = { holdTime, isClickDisabled: true, progressMemory: sharedProgress, progressIndicatorColor: '#FFD700', progressIndicatorOpacity: 1 };

        better.pressAndHold(holdOpts);
        better.addEventListener('mousedown', () => resetSiblingBars(better));
        better.addEventListener('complete.pressAndHold', () => {
            trackFeeling('better');
        });
        neutral.pressAndHold(holdOpts);
        neutral.addEventListener('mousedown', () => resetSiblingBars(neutral));
        neutral.addEventListener('complete.pressAndHold', () => {
            trackFeeling('neutral');
        });
        worse.pressAndHold(holdOpts);
        worse.addEventListener('mousedown', () => resetSiblingBars(worse));
        worse.addEventListener('complete.pressAndHold', () => {
            trackFeeling('worse');
        });
    }

    async function trackFeeling(feeling) {
        log(`User is feeling ${feeling} after ${Math.round(accumulatedPlayTime / 1000)} seconds of YouTube viewing`);
        let timestamp = new Intl.DateTimeFormat(undefined, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        }).format(new Date())
            .replace(',', '')
            .replace(' ', '_')
            .replace(/[^0-9_-]/g, '-')

        let watchedVideos = await getStoredValue("watchedVideos")
        log("watchedVideos", watchedVideos)

        browser.runtime.sendMessage({
            action: "saveFile",
            filename: `feeling-tracker/${timestamp}.json`,
            content: JSON.stringify({
                feeling,
                accumulatedPlaySeconds: Math.round(accumulatedPlayTime / 1000),
                watchedVideos
            }, null, 2)
        });

        setStoredValue("watchedVideos", [])

        const dialog = document.getElementById('feeling-dialog');
        if (dialog) { dialog.remove(); }
        accumulatedPlayTime = 0;
        setStoredValue(STORAGE_KEY_PLAYTIME, 0);
        updateLastActiveTime();
        startPlayTimeTracking();
    }

    function startPlayTimeTracking() {
        // Make sure we're not tracking multiple times
        if (checkTimer) {
            clearInterval(checkTimer);
        }

        // Set an interval to periodically check accumulated play time
        checkTimer = setInterval(() => {
            // This timer outlives the watch page that started it. Off one,
            // stop counting — a stale timestamp would otherwise charge the
            // whole detour to the next video.
            //
            // Deliberate consequence: time played in the miniplayer after you
            // navigate back to the feed does not count toward the threshold.
            // Leaving a watch page stops the clock, full stop — chosen over the
            // alternative of gating on "the main player is playing", which
            // would count it.
            if (!isWatchPage()) {
                lastPlayTimestamp = null;
                return;
            }

            // Re-query rather than trusting the cached element: YouTube can
            // swap the <video> across SPA navigation, and a detached one never
            // reports playing again, so tracking would silently stop.
            const video = getLiveVideoElement();

            // Attach before the paused check, not inside it: waiting until the
            // element is already playing means its own play event has come and
            // gone, and that handler is what records the video in watchedVideos
            // and re-syncs the accumulator from storage.
            if (video) setupVideoListeners();

            if (video && !video.paused) {
                // First check if the feeling tracker is enabled for this tab
                isEnabled().then(enabled => {
                    if (!enabled) {
                        // If disabled, don't track time at all
                        lastPlayTimestamp = null;
                        return;
                    }

                    const currentTime = Date.now();

                    if (lastPlayTimestamp) {
                        const additionalTime = currentTime - lastPlayTimestamp;
                        accumulatedPlayTime += additionalTime;

                        // Always update storage whenever the accumulated time changes
                        setStoredValue(STORAGE_KEY_PLAYTIME, accumulatedPlayTime);
                    }

                    lastPlayTimestamp = currentTime;
                    updateLastActiveTime();

                    // Check if we've reached the threshold
                    if (accumulatedPlayTime >= checkIntervalMs) {
                        showFeelingTrackerDialog();
                    }

                    // Only log every 5 seconds to reduce console spam
                    if (Math.round(accumulatedPlayTime / 1000) % 5 === 0) {
                        log(`Accumulated play time across all videos: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
                    }
                });
            }
        }, 1000); // Check every second
    }

    // Dedicated pause enforcer — runs only while the feeling dialog is up,
    // and re-pauses the video immediately if the user sneaks an un-pause
    // past us. Decoupled from the accumulator loop so it doesn't depend
    // on async isEnabled() chains or threshold math.
    let pauseEnforcerTimer = null;
    function startPauseEnforcer() {
        if (pauseEnforcerTimer) return;
        pauseEnforcerTimer = setInterval(() => {
            if (!document.getElementById('feeling-dialog')) {
                stopPauseEnforcer();
                return;
            }
            const v = getLiveVideoElement();
            if (v && !v.paused) {
                v.pause();
            }
        }, PAUSE_ENFORCER_MS);
    }
    function stopPauseEnforcer() {
        if (pauseEnforcerTimer) {
            clearInterval(pauseEnforcerTimer);
            pauseEnforcerTimer = null;
        }
    }

    // Handle video play/pause events to track actual playing time
    function setupVideoListeners() {
        // Attach once per element. Re-entry with the same <video> would stack
        // duplicate handlers; a genuinely new element does need its own.
        if (!videoElement || listenedVideoElement === videoElement) return;
        listenedVideoElement = videoElement;

        videoElement.addEventListener('play', () => {
            // Handlers outlive the page they were attached on, and the player
            // keeps playing in the miniplayer after you navigate away. Without
            // this the homepage itself gets recorded into watchedVideos.
            if (!isWatchPage()) return;

            // First check if the tracker is enabled
            isEnabled().then(enabled => {
                if (!enabled) {
                    lastPlayTimestamp = null;
                    log('Video started playing but feeling tracker is disabled, not tracking time');
                    return;
                }

                // Check for session timeout on play
                checkSessionTimeout();

                getStoredValue("watchedVideos", []).then(watchedVideos => {
                    watchedVideos.push({ title: document.title, url: window.location.href })
                    watchedVideos = watchedVideos.filter((obj1, i, arr) =>
                        arr.findIndex(obj2 => (obj2.url === obj1.url)) === i
                    )
                    setStoredValue("watchedVideos", watchedVideos)
                    log("new watchedVideos", watchedVideos)
                })

                // Always refresh the accumulated time from storage when play starts
                getStoredValue(STORAGE_KEY_PLAYTIME, 0).then(storedTime => {
                    accumulatedPlayTime = storedTime;
                    lastPlayTimestamp = Date.now();
                    updateLastActiveTime();
                    log('Video started playing, tracking time');
                    log(`Current accumulated play time from storage: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
                });
            });
        });

        videoElement.addEventListener('pause', () => {
            // Only track time if the tracker is enabled and we have a valid timestamp
            isEnabled().then(enabled => {
                if (!enabled) {
                    lastPlayTimestamp = null;
                    return;
                }

                if (lastPlayTimestamp) {
                    const currentTime = Date.now();
                    const additionalTime = currentTime - lastPlayTimestamp;
                    accumulatedPlayTime += additionalTime;

                    // Always update storage on pause
                    setStoredValue(STORAGE_KEY_PLAYTIME, accumulatedPlayTime);

                    lastPlayTimestamp = null;
                    updateLastActiveTime();
                    log(`Video paused. Accumulated play time: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
                }
            });
        });

        // When new video loads, don't reset timers, just update the last active time
        videoElement.addEventListener('loadeddata', function() {
            log('New video loaded');

            // Check if enabled before updating anything
            isEnabled().then(enabled => {
                if (!enabled) {
                    log('New video loaded but feeling tracker is disabled');
                    return;
                }

                // Refresh from storage when video loads
                getStoredValue(STORAGE_KEY_PLAYTIME, 0).then(storedTime => {
                    accumulatedPlayTime = storedTime;
                    log(`Loaded accumulated play time from storage: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
                    updateLastActiveTime();
                });
            });
        });

        // Also listen for video end to update stored values
        videoElement.addEventListener('ended', function() {
            // Check if enabled before updating anything
            isEnabled().then(enabled => {
                if (!enabled) {
                    lastPlayTimestamp = null;
                    return;
                }

                if (lastPlayTimestamp) {
                    const currentTime = Date.now();
                    const additionalTime = currentTime - lastPlayTimestamp;
                    accumulatedPlayTime += additionalTime;
                    setStoredValue(STORAGE_KEY_PLAYTIME, accumulatedPlayTime);
                    lastPlayTimestamp = null;
                    updateLastActiveTime();
                    log(`Video ended. Final accumulated play time: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
                }
            });
        });
    }

    // Status button state
    let statusButton = null;
    let statusUpdateInterval = null;
    // initializeFeelingTracker retries itself until a <video> exists, so
    // anything that must happen exactly once per page needs a guard.
    let messageListenerInstalled = false;

    function getStatusInfo() {
        const enabled = readEnabled();
        const tracking = !!(videoElement && !videoElement.paused && lastPlayTimestamp && enabled);
        const contextValid = isExtensionContextValid();

        let color, title;
        if (!contextValid) {
            color = '#888';
            title = 'Extension context lost';
        } else if (!enabled) {
            color = '#F44336';
            title = 'Feeling tracker: disabled';
        } else if (tracking) {
            color = '#4CAF50';
            title = 'Feeling tracker: active';
        } else {
            color = '#FFC107';
            title = 'Feeling tracker: enabled (idle)';
        }
        return { enabled, tracking, contextValid, color, title };
    }

    function updateStatusButton() {
        if (!statusButton) return;
        const info = getStatusInfo();
        const dot = document.getElementById("ytft-status-dot");
        if (dot) dot.style.backgroundColor = info.color;
        statusButton.title = info.title;
    }

    function createStatusButton() {
        waitForElementToBeLoaded("#center.ytd-masthead", () => {
            waitForElementToBeLoaded("#avatar-btn", () => {
                // Remove the whole previous widget, not just the button: the
                // dot lives in the container and is positioned against it, so
                // dropping only #ytft-status left an orphaned container behind
                // that rendered as a stray dot beside the new one. The button
                // and dot ids are listed too, to sweep up widgets built before
                // the container had an id of its own.
                document.querySelectorAll("#ytft-status-container, #ytft-status, #ytft-status-dot")
                    .forEach(i => i.remove());

                const container = document.createElement("div");
                container.id = "ytft-status-container";
                container.style.display = "inline-block";
                container.style.position = "relative";
                container.style.marginRight = "8px";

                statusButton = document.createElement("a");
                statusButton.textContent = "🧭";
                statusButton.id = "ytft-status";
                statusButton.style.fontSize = "32px";
                statusButton.style.cursor = "pointer";
                statusButton.style.userSelect = "none";
                statusButton.title = "Feeling tracker: loading...";
                statusButton.addEventListener("click", openStatusMenu);

                const dot = document.createElement("span");
                dot.id = "ytft-status-dot";
                dot.style.position = "absolute";
                dot.style.bottom = "2px";
                dot.style.right = "-2px";
                dot.style.width = "12px";
                dot.style.height = "12px";
                dot.style.borderRadius = "50%";
                dot.style.backgroundColor = "#888";
                dot.style.border = "2px solid white";
                dot.style.pointerEvents = "none";

                container.appendChild(statusButton);
                container.appendChild(dot);

                const endContainer = document.querySelector("#center.ytd-masthead");
                if (endContainer) {
                    endContainer.prepend(container);
                }

                updateStatusButton();
                // The retry loop can land here more than once per page.
                if (statusUpdateInterval) clearInterval(statusUpdateInterval);
                statusUpdateInterval = setInterval(updateStatusButton, 2000);
            });
        });
    }

    function openStatusMenu() {
        // Remove existing menu if open
        const existing = document.getElementById('ytft-status-menu-backdrop');
        if (existing) {
            existing._closeDialog?.();
            existing.remove();
            return;
        }

        const info = getStatusInfo();

        const backdrop = document.createElement("div");
        backdrop.id = "ytft-status-menu-backdrop";
        backdrop.style.position = "fixed";
        backdrop.style.top = "0";
        backdrop.style.left = "0";
        backdrop.style.width = "100%";
        backdrop.style.height = "100%";
        backdrop.style.backgroundColor = "rgba(0, 0, 0, 0.7)";
        backdrop.style.zIndex = "9999";
        backdrop.style.display = "flex";
        backdrop.style.justifyContent = "center";
        backdrop.style.alignItems = "center";

        const panel = document.createElement("div");
        panel.style.backgroundColor = "white";
        panel.style.borderRadius = "12px";
        panel.style.padding = "30px";
        panel.style.width = "480px";
        panel.style.maxWidth = "90%";
        panel.style.color = "#333";

        const title = document.createElement("h2");
        title.textContent = "Feeling Tracker Status";
        title.style.margin = "0 0 24px 0";
        title.style.textAlign = "center";
        title.style.fontSize = "28px";
        panel.appendChild(title);

        // Status rows container
        const rowsContainer = document.createElement("div");
        rowsContainer.id = "ytft-status-rows";
        panel.appendChild(rowsContainer);

        function getRowData() {
            const info = getStatusInfo();
            return [
                { label: "Extension context", value: info.contextValid ? "Valid" : "Lost", color: info.contextValid ? "#4CAF50" : "#F44336" },
                { label: "Enabled", value: info.enabled ? "Yes" : "No", color: info.enabled ? "#4CAF50" : "#F44336" },
                { label: "Tracking", value: info.tracking ? "Active" : "Idle", color: info.tracking ? "#4CAF50" : "#FFC107" },
                { label: "Video element", value: videoElement ? "Found" : "Not found", color: videoElement ? "#4CAF50" : "#F44336" },
                { label: "Accumulated time", value: `${Math.round(accumulatedPlayTime / 1000)}s / ${Math.round(checkIntervalMs / 1000)}s`, color: "#333" },
                { label: "Tab ID", value: currentTabId ?? "Unknown", color: "#333" },
            ];
        }

        function renderRows() {
            rowsContainer.innerHTML = "";
            getRowData().forEach(row => {
                const div = document.createElement("div");
                div.style.display = "flex";
                div.style.justifyContent = "space-between";
                div.style.alignItems = "center";
                div.style.padding = "10px 0";
                div.style.borderBottom = "1px solid #eee";

                const lbl = document.createElement("span");
                lbl.textContent = row.label;
                lbl.style.fontWeight = "bold";
                lbl.style.fontSize = "20px";

                const val = document.createElement("span");
                val.textContent = row.value;
                val.style.color = row.color;
                val.style.fontSize = "20px";

                div.appendChild(lbl);
                div.appendChild(val);
                rowsContainer.appendChild(div);
            });
        }

        renderRows();
        const dialogRefreshInterval = setInterval(renderRows, 1000);

        function closeDialog() {
            clearInterval(dialogRefreshInterval);
            backdrop.remove();
        }
        backdrop._closeDialog = closeDialog;

        // Toggle button
        const toggleBtn = document.createElement("button");
        toggleBtn.textContent = info.enabled ? "Disable Tracker" : "Enable Tracker";
        toggleBtn.style.display = "block";
        toggleBtn.style.width = "100%";
        toggleBtn.style.padding = "14px";
        toggleBtn.style.marginTop = "20px";
        toggleBtn.style.border = "none";
        toggleBtn.style.borderRadius = "6px";
        toggleBtn.style.backgroundColor = info.enabled ? "#F44336" : "#4CAF50";
        toggleBtn.style.color = "white";
        toggleBtn.style.cursor = "pointer";
        toggleBtn.style.fontSize = "18px";
        toggleBtn.addEventListener("click", () => {
            // toggleEnabled() updates the button itself, synchronously.
            toggleEnabled();
            closeDialog();
        });
        panel.appendChild(toggleBtn);

        // Trigger dialog button
        const triggerBtn = document.createElement("button");
        triggerBtn.textContent = "Show Feeling Dialog (Debug)";
        triggerBtn.style.display = "block";
        triggerBtn.style.width = "100%";
        triggerBtn.style.padding = "14px";
        triggerBtn.style.marginTop = "10px";
        triggerBtn.style.border = "none";
        triggerBtn.style.borderRadius = "6px";
        triggerBtn.style.backgroundColor = "#2196F3";
        triggerBtn.style.color = "white";
        triggerBtn.style.cursor = "pointer";
        triggerBtn.style.fontSize = "18px";
        triggerBtn.addEventListener("click", () => {
            closeDialog();
            showFeelingTrackerDialog({ debug: true });
        });
        panel.appendChild(triggerBtn);

        // Close button
        const closeBtn = document.createElement("button");
        closeBtn.textContent = "Close";
        closeBtn.style.display = "block";
        closeBtn.style.width = "100%";
        closeBtn.style.padding = "12px";
        closeBtn.style.marginTop = "10px";
        closeBtn.style.border = "1px solid #ccc";
        closeBtn.style.borderRadius = "6px";
        closeBtn.style.backgroundColor = "white";
        closeBtn.style.color = "#333";
        closeBtn.style.cursor = "pointer";
        closeBtn.style.fontSize = "18px";
        closeBtn.addEventListener("click", () => closeDialog());
        panel.appendChild(closeBtn);

        backdrop.appendChild(panel);
        backdrop.addEventListener("click", (e) => {
            if (e.target === backdrop) closeDialog();
        });
        document.body.appendChild(backdrop);
    }

    // Function to initialize the feeling tracker
    function initializeFeelingTracker() {
        // Check if extension context is valid
        if (!isExtensionContextValid()) {
            debug('Extension context invalid, cannot initialize feeling tracker');
            return;
        }

        // Don't run in private/incognito windows — feeling data shouldn't be
        // recorded for private browsing sessions.
        if (browser.extension && browser.extension.inIncognitoContext) {
            log('Private browsing context detected, feeling tracker disabled');
            return;
        }

        // Create status button on any YouTube page
        if (window.location.hostname === "www.youtube.com") {
            createStatusButton();
        }

        installMessageListener();
        watchForSpaNavigation();

        // Only run tracking on YouTube watch pages
        if (!isWatchPage()) {
            return;
        }

        // Check for session timeout on load
        checkSessionTimeout();

        // Listen for page visibility changes to handle tab switching. Attached
        // once per document — this function re-enters, and every extra copy
        // would run the accumulate-on-hide branch again.
        if (!visibilityListenerInstalled) {
            visibilityListenerInstalled = true;
            document.addEventListener('visibilitychange', onVisibilityChange);
        }

        // Find the main player. The SPA watcher fires at the start of a
        // navigation, so this often runs before it has rendered — the retry
        // below is the normal path there, not an edge case.
        videoElement = findMainVideo();

        if (videoElement) {
            log('Video element found, starting tracker.');

            // Always start with a fresh value from storage
            getStoredValue(STORAGE_KEY_PLAYTIME, 0).then(storedTime => {
                accumulatedPlayTime = storedTime;
                log(`Starting with accumulated play time from storage: ${Math.round(accumulatedPlayTime / 1000)} seconds`);

                setupVideoListeners();
                startPlayTimeTracking();

                // Set only once tracking is genuinely running, so a failure
                // above leaves the SPA watcher and the retry loop free to try
                // again rather than latching a half-started tracker.
                trackingActive = true;

                // From here the watcher can never act again — stop paying for
                // a document-wide subtree observer on a page that mutates
                // constantly.
                if (spaObserver) {
                    spaObserver.disconnect();
                    spaObserver = null;
                }

                // Set up session timeout check timer
                if (sessionTimer) {
                    clearInterval(sessionTimer);
                }
                sessionTimer = setInterval(checkSessionTimeout, 60000); // Check every minute
            });
        } else {
            // Try again in a second if video not found. Kept to a single chain:
            // the SPA watcher can re-enter while a retry is already pending, and
            // two chains both re-read the accumulator from storage, so whichever
            // resolves last discards the seconds the other one had banked.
            log('Video element not found, trying again soon.');
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = setTimeout(() => {
                retryTimer = null;
                initializeFeelingTracker();
            }, 1000);
        }

    function showColorTestDialog() {
        const existing = document.getElementById('color-test-backdrop');
        if (existing) existing.remove();

        const baseColor = { name: 'Neutral', color: '#2196F3' };

        const overlayColors = [
            { name: 'White', color: '#ffffff' },
            { name: 'Gold', color: '#FFD700' },
            { name: 'Light Gold', color: '#FFECB3' },
            { name: 'Amber', color: '#FFC107' },
            { name: 'Pale Yellow', color: '#FFF9C4' },
            { name: 'Silver', color: '#C0C0C0' },
            { name: 'Cyan', color: '#00BCD4' },
            { name: 'Light Cyan', color: '#B2EBF2' },
            { name: 'Peach', color: '#FFAB91' },
            { name: 'Coral', color: '#FF7043' },
            { name: 'Lavender', color: '#CE93D8' },
            { name: 'Mint', color: '#A5D6A7' },
            { name: 'Sky Blue', color: '#81D4FA' },
            { name: 'Orange', color: '#FF9800' },
        ];

        const opacities = [0.3, 0.4, 0.5, 0.6, 0.7];

        const backdrop = document.createElement('div');
        backdrop.id = 'color-test-backdrop';
        backdrop.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:999999;display:flex;align-items:center;justify-content:center;';
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:#1a1a1a;color:#fff;padding:24px;border-radius:12px;max-height:85vh;overflow-y:auto;max-width:90vw;';

        let html = '<h2 style="margin-top:0;margin-bottom:16px;">Blue Overlay Color Test</h2>';

        // Original button
        html += '<h3 style="margin-bottom:8px;color:#aaa;">Original (no overlay)</h3>';
        html += `<div style="width:180px;height:40px;background:${baseColor.color};border-radius:4px;margin-bottom:20px;"></div>`;

        // Grid: each overlay color as a row, opacities as columns
        html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">';
        html += '<div style="width:110px;"></div>';
        for (const opacity of opacities) {
            html += `<div style="width:180px;text-align:center;font-size:11px;color:#666;">${Math.round(opacity * 100)}%</div>`;
        }
        html += '</div>';

        for (const overlay of overlayColors) {
            html += `<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">`;
            html += `<div style="width:110px;font-size:12px;color:#aaa;flex-shrink:0;">${overlay.name}<br><span style="font-size:10px;color:#666;">${overlay.color}</span></div>`;
            for (const opacity of opacities) {
                html += `<div style="width:180px;height:40px;border-radius:4px;position:relative;overflow:hidden;">
                    <div style="width:100%;height:100%;background:${baseColor.color};"></div>
                    <div style="position:absolute;top:0;left:0;width:60%;height:100%;background:${overlay.color};opacity:${opacity};"></div>
                </div>`;
            }
            html += '</div>';
        }

        dialog.innerHTML = html;
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);
    }

    // Installed before the non-watch-page early return, and exactly once per
    // document. It used to sit at the end of this function, which meant only a
    // tab whose *initial* URL was a /watch page ever got a listener — YouTube
    // is an SPA, so clicking into a video from the homepage left the tab with a
    // permanently dead context menu. The retry loop also re-entered this
    // function, and every extra listener ran toggleEnabled() again on a single
    // toggle message: harmless while the toggle was async and every copy
    // computed the same value, but a synchronous toggle flips N times and an
    // even N is a silent no-op.
    function installMessageListener() {
        if (messageListenerInstalled) return;
        if (!isExtensionContextValid()) {
            debug('Extension context invalid, cannot install message listener');
            return;
        }

        log("installing listener")
        browser.runtime.onMessage.addListener(data => {
            log("message received", data)
            switch (data.trigger) {
                // The enable flag lives in this tab's sessionStorage now,
                // so the background page has to ask us for it.
                case "getFeelingTrackerState":
                    return Promise.resolve({ enabled: readEnabled() });
                case "showFeelingTrackerDialog":
                    // Off a watch page this would latch videoElement onto a
                    // hover-preview player, pause-enforce it, and — once the
                    // hold completes — start the accumulator on a page the
                    // early return above is meant to keep untracked.
                    if (!isWatchPage()) {
                        log('Ignoring dialog request: not a watch page');
                        break;
                    }
                    showFeelingTrackerDialog({ debug: true });
                    break;
                case "toggleFeelingTracker":
                    toggleEnabled();
                    break;
                case "showColorTest":
                    showColorTestDialog();
                    break;
            }
        });
        // Set after the call, so a throw here leaves a retry able to install.
        messageListenerInstalled = true;
    }
    }

    return initializeFeelingTracker
})();
