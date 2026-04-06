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
    const STORAGE_KEY_PLAYTIME = 'ytf_accumulatedPlayTime';
    const STORAGE_KEY_LASTACTIVE = 'ytf_lastActiveTime';
    const STORAGE_KEY_ENABLED = 'ytf_feelingTracker_enabled';

    let checkIntervalMs = CHECK_INTERVAL_MINUTES * 60 * 1000;
    let sessionTimeoutMs = SESSION_TIMEOUT_MINUTES * 60 * 1000;
    let checkTimer = null;
    let sessionTimer = null;
    let videoElement = null;
    let lastPlayTimestamp = null;
    let accumulatedPlayTime = 0;
    let lastActiveTime = 0;
    let currentTabId = null;

    // Get the current tab ID on initialization
    if (isExtensionContextValid()) {
        browser.runtime.sendMessage({ action: "getTabId" })
            .then(response => {
                currentTabId = response.tabId;
                log(`Got current tab ID: ${currentTabId}`);
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

    function getStorageKey(baseKey) {
        return currentTabId ? `${baseKey}_${currentTabId}` : baseKey;
    }

    function isEnabled() {
        return safeStorageGet(getStorageKey(STORAGE_KEY_ENABLED))
            .then(result => {
                const enabled = result[getStorageKey(STORAGE_KEY_ENABLED)] !== false;
                debug(`Feeling tracker is ${enabled ? 'enabled' : 'disabled'} for tab ${currentTabId}`);
                return enabled;
            })
            .catch(err => {
                error(`Error checking if enabled: ${err}`);
                return true; // Default to enabled if there's an error
            });
    }

    function toggleEnabled() {
        isEnabled().then(enabled => {
            const newState = !enabled;
            const data = {};
            data[getStorageKey(STORAGE_KEY_ENABLED)] = newState;

            return safeStorageSet(data)
                .then(() => {
                    log(`Feeling tracker is now ${newState ? 'enabled' : 'disabled'} for tab ${currentTabId}`);
                    alert(`Feeling tracker is now ${newState ? 'enabled' : 'disabled'}`);
                })
                .catch(err => {
                    error(`Error toggling enabled state: ${err}`);
                });
        });
    }

    function getStoredValue(key, defaultValue) {
        // Only use tab-specific key for the enabled setting, others are global
        const storageKey = key === STORAGE_KEY_ENABLED ? getStorageKey(key) : key;

        return safeStorageGet(storageKey)
            .then(result => {
                return result[storageKey] !== undefined ? JSON.parse(result[storageKey]) : defaultValue;
            })
            .catch(err => {
                error(`Error getting stored value: ${err}`);
                return defaultValue;
            });
    }

    // Helper function to set values in browser storage
    function setStoredValue(key, value) {
        // Only use tab-specific key for the enabled setting, others are global
        const storageKey = key === STORAGE_KEY_ENABLED ? getStorageKey(key) : key;

        let data = {};
        data[storageKey] = JSON.stringify(value);
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

    // Function to update last active time
    function updateLastActiveTime() {
        const currentTime = Date.now();
        lastActiveTime = currentTime;
        setStoredValue(STORAGE_KEY_LASTACTIVE, currentTime);
    }

    async function showFeelingTrackerDialog() {
        if (videoElement && !videoElement.paused) {
            videoElement.pause();
        }

        let d = document.getElementById('feeling-dialog')
        if (d) { return }

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

        let holdTime = 10000;

        let better = document.getElementById('feeling-better');
        better.pressAndHold({ holdTime, isClickDisabled: true });
        better.addEventListener('complete.pressAndHold', () => {
            trackFeeling('better');
        });
        let neutral = document.getElementById('feeling-neutral');
        neutral.pressAndHold({ holdTime, isClickDisabled: true });
        neutral.addEventListener('complete.pressAndHold', () => {
            trackFeeling('neutral');
        });
        let worse = document.getElementById('feeling-worse');
        worse.pressAndHold({ holdTime, isClickDisabled: true });
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

        /*saveFile(`feeling-tracker.${timestamp}.txt`, JSON.stringify({
            feeling, watchedVideos
        }));*/

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
            if (videoElement && !videoElement.paused) {
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

    // Handle video play/pause events to track actual playing time
    function setupVideoListeners() {
        if (!videoElement) return;

        videoElement.addEventListener('play', () => {
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

    // Function to initialize the feeling tracker
    function initializeFeelingTracker() {
        // Check if extension context is valid
        if (!isExtensionContextValid()) {
            debug('Extension context invalid, cannot initialize feeling tracker');
            return;
        }

        // Only run on YouTube watch pages
        if (window.location.hostname !== "www.youtube.com" || !window.location.pathname.includes("/watch")) {
            return;
        }

        // Check for session timeout on load
        checkSessionTimeout();

        // Listen for page visibility changes to handle tab switching
        document.addEventListener('visibilitychange', function() {
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
        });

        // Find the video element
        videoElement = document.querySelector('video');

        if (videoElement) {
            log('Video element found, starting tracker.');

            // Always start with a fresh value from storage
            getStoredValue(STORAGE_KEY_PLAYTIME, 0).then(storedTime => {
                accumulatedPlayTime = storedTime;
                log(`Starting with accumulated play time from storage: ${Math.round(accumulatedPlayTime / 1000)} seconds`);

                setupVideoListeners();
                startPlayTimeTracking();

                // Set up session timeout check timer
                if (sessionTimer) {
                    clearInterval(sessionTimer);
                }
                sessionTimer = setInterval(checkSessionTimeout, 60000); // Check every minute
            });
        } else {
            // Try again in a second if video not found
            log('Video element not found, trying again soon.');
            setTimeout(initializeFeelingTracker, 1000);
        }

        log("installing listener")
        if (isExtensionContextValid()) {
            browser.runtime.onMessage.addListener(data => {
                log("message received", data)
                switch (data.trigger) {
                    case "showFeelingTrackerDialog":
                        showFeelingTrackerDialog();
                        break;
                    case "toggleFeelingTracker":
                        toggleEnabled();
                        break;
                }
            });
        } else {
            debug('Extension context invalid, cannot install message listener');
        }
    }

    return initializeFeelingTracker
})();
