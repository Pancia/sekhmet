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
                    if (!newState) {
                        const dialog = document.getElementById('feeling-dialog');
                        if (dialog) dialog.remove();
                        stopPauseEnforcer();
                        lastPlayTimestamp = null;
                    }
                    updateStatusButton();
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

    function getLiveVideoElement() {
        // YouTube is a SPA — the cached videoElement can become stale
        // or disconnected after navigation. Prefer a fresh query, and
        // refresh the cache if the current one is no longer in the DOM.
        if (!videoElement || !videoElement.isConnected) {
            const fresh = document.querySelector('video');
            if (fresh) videoElement = fresh;
        }
        return videoElement;
    }

    async function showFeelingTrackerDialog({ debug: isDebug = false } = {}) {
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

    // Status button state
    let statusButton = null;
    let statusUpdateInterval = null;

    function getStatusInfo() {
        const enabled = statusButton?.dataset.enabled === 'true';
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
        isEnabled().then(enabled => {
            statusButton.dataset.enabled = enabled;
            const info = getStatusInfo();
            const dot = document.getElementById("ytft-status-dot");
            if (dot) dot.style.backgroundColor = info.color;
            statusButton.title = info.title;
        });
    }

    function createStatusButton() {
        waitForElementToBeLoaded("#center.ytd-masthead", () => {
            waitForElementToBeLoaded("#avatar-btn", () => {
                document.querySelectorAll("#ytft-status").forEach(i => i.remove());

                const container = document.createElement("div");
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
            toggleEnabled();
            closeDialog();
            setTimeout(updateStatusButton, 500);
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

        // Only run tracking on YouTube watch pages
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

        log("installing listener")
        if (isExtensionContextValid()) {
            browser.runtime.onMessage.addListener(data => {
                log("message received", data)
                switch (data.trigger) {
                    case "showFeelingTrackerDialog":
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
        } else {
            debug('Extension context invalid, cannot install message listener');
        }
    }

    return initializeFeelingTracker
})();
