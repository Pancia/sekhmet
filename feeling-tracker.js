// Firefox Extension port of feeling-tracker.js
// Ported from Greasemonkey script to WebExtension format

// Global configuration
const CHECK_INTERVAL_MINUTES = 5; // Check-in interval in minutes
const SESSION_TIMEOUT_MINUTES = 5; // Session timeout in minutes
const STORAGE_KEY_PLAYTIME = 'ytf_accumulatedPlayTime';
const STORAGE_KEY_LASTACTIVE = 'ytf_lastActiveTime';

let checkIntervalMs = CHECK_INTERVAL_MINUTES * 60 * 1000;
let sessionTimeoutMs = SESSION_TIMEOUT_MINUTES * 60 * 1000;
let checkTimer = null;
let sessionTimer = null;
let videoElement = null;
let lastPlayTimestamp = null;
let accumulatedPlayTime = 0;
let lastActiveTime = 0;

// Helper function to get values from browser storage
function getStoredValue(key, defaultValue) {
    return browser.storage.local.get(key)
        .then(result => {
            return result[key] !== undefined ? parseFloat(result[key]) : defaultValue;
        })
        .catch(error => {
            console.error(`YTF: Error getting stored value: ${error}`);
            return defaultValue;
        });
}

// Helper function to set values in browser storage
function setStoredValue(key, value) {
    let data = {};
    data[key] = value.toString();
    return browser.storage.local.set(data)
        .catch(error => {
            console.error(`YTF: Error setting stored value: ${error}`);
        });
}

// Function to check if session has timed out
function checkSessionTimeout() {
    getStoredValue(STORAGE_KEY_LASTACTIVE, 0).then(storedLastActiveTime => {
        lastActiveTime = storedLastActiveTime;
        const currentTime = Date.now();
        const timeSinceLastActive = currentTime - lastActiveTime;

        if (lastActiveTime > 0 && timeSinceLastActive > sessionTimeoutMs) {
            console.log(`YTF: Session timeout: ${Math.round(timeSinceLastActive / 1000)} seconds since last activity, resetting accumulated time`);
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

function showFeelingTrackerDialog() {
    if (videoElement && !videoElement.paused) {
        videoElement.pause();
    }

    if (!document.getElementById('feeling-dialog')) {
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

        let holdTime = 2500;
        let better = document.getElementById('feeling-better');
        better.pressAndHold({ holdTime });
        better.addEventListener('complete.pressAndHold', () => {
            trackFeeling('better');
        });
        let neutral = document.getElementById('feeling-neutral');
        neutral.pressAndHold({ holdTime });
        neutral.addEventListener('complete.pressAndHold', () => {
            trackFeeling('neutral');
        });
        let worse = document.getElementById('feeling-worse');
        worse.pressAndHold({ holdTime });
        worse.addEventListener('complete.pressAndHold', () => {
            trackFeeling('worse');
        });
    } else {
        document.getElementById('feeling-dialog').style.display = 'block';
    }
}

function trackFeeling(feeling) {
    console.log(`YTF: User is feeling ${feeling} after ${Math.round(accumulatedPlayTime / 1000)} seconds of YouTube viewing`);

    const dialog = document.getElementById('feeling-dialog');
    if (dialog) {
        dialog.style.display = 'none';
    }
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
                console.log(`YTF: Accumulated play time across all videos: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
            }
        }
    }, 1000); // Check every second
}

// Handle video play/pause events to track actual playing time
function setupVideoListeners() {
    if (!videoElement) return;

    videoElement.addEventListener('play', () => {
        // Check for session timeout on play
        checkSessionTimeout();

        // Always refresh the accumulated time from storage when play starts
        getStoredValue(STORAGE_KEY_PLAYTIME, 0).then(storedTime => {
            accumulatedPlayTime = storedTime;
            lastPlayTimestamp = Date.now();
            updateLastActiveTime();
            console.log('YTF: Video started playing, tracking time');
            console.log(`YTF: Current accumulated play time from storage: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
        });
    });

    videoElement.addEventListener('pause', () => {
        if (lastPlayTimestamp) {
            const currentTime = Date.now();
            const additionalTime = currentTime - lastPlayTimestamp;
            accumulatedPlayTime += additionalTime;

            // Always update storage on pause
            setStoredValue(STORAGE_KEY_PLAYTIME, accumulatedPlayTime);

            lastPlayTimestamp = null;
            updateLastActiveTime();
            console.log(`YTF: Video paused. Accumulated play time: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
        }
    });

    // When new video loads, don't reset timers, just update the last active time
    videoElement.addEventListener('loadeddata', function() {
        console.log('YTF: New video loaded');

        // Refresh from storage when video loads
        getStoredValue(STORAGE_KEY_PLAYTIME, 0).then(storedTime => {
            accumulatedPlayTime = storedTime;
            console.log(`YTF: Loaded accumulated play time from storage: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
            updateLastActiveTime();
        });
    });

    // Also listen for video end to update stored values
    videoElement.addEventListener('ended', function() {
        if (lastPlayTimestamp) {
            const currentTime = Date.now();
            const additionalTime = currentTime - lastPlayTimestamp;
            accumulatedPlayTime += additionalTime;
            setStoredValue(STORAGE_KEY_PLAYTIME, accumulatedPlayTime);
            lastPlayTimestamp = null;
            updateLastActiveTime();
            console.log(`YTF: Video ended. Final accumulated play time: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
        }
    });
}

// Function to initialize the feeling tracker
function initializeFeelingTracker() {
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
                console.log(`YTF: Page hidden. Updated accumulated play time: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
            }
        } else {
            // Page is visible again - refresh from storage
            getStoredValue(STORAGE_KEY_PLAYTIME, 0).then(storedTime => {
                accumulatedPlayTime = storedTime;
                console.log(`YTF: Page visible again. Refreshed accumulated play time: ${Math.round(accumulatedPlayTime / 1000)} seconds`);
            });
        }
    });

    // Find the video element
    videoElement = document.querySelector('video');

    if (videoElement) {
        console.log('YTF: Video element found, starting tracker.');

        // Always start with a fresh value from storage
        getStoredValue(STORAGE_KEY_PLAYTIME, 0).then(storedTime => {
            accumulatedPlayTime = storedTime;
            console.log(`YTF: Starting with accumulated play time from storage: ${Math.round(accumulatedPlayTime / 1000)} seconds`);

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
        console.log('YTF: Video element not found, trying again soon.');
        setTimeout(initializeFeelingTracker, 1000);
    }
}

console.log("YTF: installing listener")
browser.runtime.onMessage.addListener(data => {
    console.log("YTF: message received", data)
    const { trigger } = data;
    if (trigger === 'showFeelingTrackerDialog')
        showFeelingTrackerDialog();
});
