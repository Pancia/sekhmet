// Firefox Extension port of overlays.js
// Ported from Greasemonkey script to WebExtension format

// Global settings
const __overlays_time = 3000;
const __max_items_shown = 5; // Maximum number of comments or related videos to show

// Cookie-like storage helper using browser.storage.local
const Cookies = {
    get: function(key) {
        return browser.storage.local.get(key)
            .then(result => result[key])
            .catch(error => {
                console.error(`Overlays: Error getting stored value: ${error}`);
                return null;
            });
    },
    set: function(key, value) {
        let data = {};
        data[key] = value;
        return browser.storage.local.set(data)
            .catch(error => {
                console.error(`Overlays: Error setting stored value: ${error}`);
            });
    },
    remove: function(key) {
        return browser.storage.local.remove(key)
            .catch(error => {
                console.error(`Overlays: Error removing stored value: ${error}`);
            });
    }
};

// Check if overlays are enabled for the user
async function isEnabledForUser() {
    const now = Date.now();
    const isEnabled = await Cookies.get("overlays:isDisabled") != "true";
    const disabledUntil = await Cookies.get("overlays:disabledUntil") || 0;

    if (now > disabledUntil) {
        Cookies.remove("overlays:disabledUntil");
    }

    return isEnabled && now > disabledUntil;
}

// Add a global CSS style
function addGlobalStyle(css) {
    const head = document.getElementsByTagName('head')[0];
    if (!head) { return; }

    const style = document.createElement('style');
    style.type = 'text/css';
    style.innerHTML = css;
    head.appendChild(style);
}

// Add overlay to an element
function addOverlay(selector, text, holdTime, callback) {
    const targetElement = document.querySelector(selector);
    if (!targetElement) return null;

    const overlay = document.createElement('div');
    overlay.id = selector.replace(/[^a-zA-Z0-9]/g, '_');
    overlay.style.width = targetElement.offsetWidth + 'px';
    overlay.style.opacity = '1';
    overlay.style.position = 'absolute';
    overlay.style.backgroundColor = 'black';
    overlay.style.height = '100%';
    overlay.style.zIndex = '2200';

    const button = document.createElement('button');
    button.textContent = text || `Show: ${selector}`;
    button.style.height = '100px';
    button.style.width = '100%';
    button.style.fontSize = '22px';
    button.style.backgroundColor = 'white';

    button.pressAndHold({ holdTime: holdTime || 5000 });
    button.addEventListener('complete.pressAndHold', () => {
        const overlayElements = document.querySelectorAll(`[id='${overlay.id}']`);
        overlayElements.forEach(el => el.remove());
        if (typeof callback === 'function') {
            setTimeout(callback, 0);
        }
    });

    overlay.appendChild(button);
    targetElement.prepend(overlay);

    return overlay;
}

// Add overlay to an element with a custom button
function addOverlayTo(elementSelector, overlayID, buttonConfig, opts) {
    const element = document.querySelector(elementSelector);
    if (!element) return;

    const overlay = document.createElement('div');
    overlay.id = overlayID;
    overlay.style.width = element.offsetWidth + 'px';
    overlay.style.opacity = '1';
    overlay.style.position = 'absolute';
    overlay.style.backgroundColor = 'black';
    overlay.style.height = '100%';
    overlay.style.zIndex = '2200';

    const button = document.createElement('button');
    if (buttonConfig.html) {
        button.innerHTML = buttonConfig.html;
    } else if (buttonConfig.text) {
        button.textContent = buttonConfig.text;
    }

    if (buttonConfig.styles) {
        Object.assign(button.style, buttonConfig.styles);
    }

    button.pressAndHold(opts);
    button.addEventListener('complete.pressAndHold', () => {
        try { element.setAttribute("data-overlay", "disabled"); } catch(e) {}
        const overlayElements = document.querySelectorAll(`[id='${overlayID}']`);
        overlayElements.forEach(el => el.remove());
    });

    overlay.appendChild(button);
    element.prepend(overlay);
}

// Format time for display
function displayTime(date) {
    return new Date(Number(date)).toLocaleTimeString("en-US", { hour: "numeric", minute: "numeric", hourCycle: "h24"});
}

// Function to add individual overlays to each item
function addIndividualOverlays(containerSelector, itemSelector, itemName) {
    console.log(`Adding individual overlays to ${itemName}`);

    // Find the container
    const container = document.querySelector(containerSelector);
    if (!container) {
        console.log(`Container ${containerSelector} not found`);
        return;
    }

    // Get all items
    const allItems = Array.from(container.querySelectorAll(itemSelector));
    if (allItems.length === 0) {
        console.log(`No ${itemName} found`);
        return;
    }

    console.log(`Found ${allItems.length} ${itemName} to overlay`);

    // Add overlay to each individual item
    allItems.forEach((item, index) => {
        // Skip items that already have an overlay
        if (item.querySelector('.individual-item-overlay')) {
            return;
        }

        // Create a unique ID for this item if it doesn't have one
        if (!item.id) {
            item.id = `${itemName}-item-${index}-${Date.now()}`;
        }

        // Create overlay for this item
        const overlay = document.createElement('div');
        overlay.className = 'individual-item-overlay';
        overlay.dataset.itemType = itemName;
        overlay.dataset.itemIndex = index;
        overlay.style.position = 'absolute';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
        overlay.style.zIndex = '1000'; // Higher z-index to ensure visibility
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.boxSizing = 'border-box';
        overlay.style.border = '2px solid #065fd4';
        overlay.style.minHeight = '50px';

        // Add a blur backdrop filter
        overlay.style.backdropFilter = 'blur(5px)';
        overlay.style.webkitBackdropFilter = 'blur(5px)'; // For Safari

        // Add a semi-transparent div to further obscure content
        const blurLayer = document.createElement('div');
        blurLayer.style.position = 'absolute';
        blurLayer.style.top = '0';
        blurLayer.style.left = '0';
        blurLayer.style.width = '100%';
        blurLayer.style.height = '100%';
        blurLayer.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
        overlay.appendChild(blurLayer);

        // Create reveal button
        const revealButton = document.createElement('button');
        const itemType = itemName === 'comments' ? 'comment' : 'video';
        revealButton.textContent = `Reveal this ${itemType} and 2 below`;
        revealButton.style.whiteSpace = 'nowrap';
        revealButton.style.backgroundColor = '#065fd4';
        revealButton.style.color = 'white';
        revealButton.style.border = 'none';
        revealButton.style.borderRadius = '2px';
        revealButton.style.padding = '8px 14px';
        revealButton.style.fontSize = '13px';
        revealButton.style.cursor = 'pointer';

        // Add pressAndHold behavior
        revealButton.pressAndHold({ holdTime: __overlays_time });

        // When button is held, remove this overlay and adjacent ones
        revealButton.addEventListener('complete.pressAndHold', () => {
            // Remove this overlay
            overlay.remove();

            // Find and remove adjacent overlays (2 above and 2 below)
            const allItems = Array.from(container.querySelectorAll(itemSelector));
            const currentIndex = allItems.indexOf(item);

            // Function to get and remove adjacent overlays
            const removeAdjacentOverlays = (itemIndex, direction, count) => {
                for (let i = 1; i <= count; i++) {
                    const adjacentIndex = itemIndex + (direction * i);
                    if (adjacentIndex >= 0 && adjacentIndex < allItems.length) {
                        const adjacentItem = allItems[adjacentIndex];
                        const adjacentOverlay = adjacentItem.querySelector('.individual-item-overlay');
                        if (adjacentOverlay) {
                            adjacentOverlay.remove();
                        }
                    }
                }
            };

            // removeAdjacentOverlays(currentIndex, -1, 2); // Remove above
            removeAdjacentOverlays(currentIndex, 1, 2);  // Remove below

            console.log(`Revealed ${itemName} item at index ${currentIndex} and adjacent items`);
        });

        // Add button to overlay
        overlay.appendChild(revealButton);

        // Make sure the item has position relative for proper overlay positioning
        const currentPosition = window.getComputedStyle(item).position;
        if (currentPosition === 'static') {
            item.style.position = 'relative';
        }

        // Add overlay to the item
        item.appendChild(overlay);
    });

    console.log(`Added overlays to ${allItems.length} ${itemName}`);

    // Set up a mutation observer to handle newly added items
    const observer = new MutationObserver((mutations) => {
        let newItemsAdded = false;

        mutations.forEach(mutation => {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                for (const node of mutation.addedNodes) {
                    // Check if this is an item or contains items
                    if ((node.matches && node.matches(itemSelector)) ||
                        (node.querySelector && node.querySelector(itemSelector))) {
                        newItemsAdded = true;
                        break;
                    }
                }
            }
        });

        if (newItemsAdded) {
            console.log(`New ${itemName} detected, adding overlays`);
            setTimeout(() => {
                // Find items without overlays
                const newItems = Array.from(container.querySelectorAll(itemSelector))
                    .filter(item => !item.querySelector('.individual-item-overlay'));

                newItems.forEach((item, index) => {
                    // Create item ID
                    if (!item.id) {
                        item.id = `${itemName}-item-new-${index}-${Date.now()}`;
                    }

                    // Create overlay
                    const overlay = document.createElement('div');
                    overlay.className = 'individual-item-overlay';
                    overlay.dataset.itemType = itemName;
                    overlay.dataset.itemIndex = index;
                    overlay.style.position = 'absolute';
                    overlay.style.top = '0';
                    overlay.style.left = '0';
                    overlay.style.width = '100%';
                    overlay.style.height = '100%';
                    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
                    overlay.style.zIndex = '1000'; // Higher z-index to ensure visibility
                    overlay.style.display = 'flex';
                    overlay.style.alignItems = 'center';
                    overlay.style.justifyContent = 'center';
                    overlay.style.boxSizing = 'border-box';
                    overlay.style.border = '2px solid #065fd4';
                    overlay.style.minHeight = '50px';

                    // Add a blur backdrop filter
                    overlay.style.backdropFilter = 'blur(5px)';
                    overlay.style.webkitBackdropFilter = 'blur(5px)'; // For Safari

                    // Add a semi-transparent div to further obscure content
                    const blurLayer = document.createElement('div');
                    blurLayer.style.position = 'absolute';
                    blurLayer.style.top = '0';
                    blurLayer.style.left = '0';
                    blurLayer.style.width = '100%';
                    blurLayer.style.height = '100%';
                    blurLayer.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
                    overlay.appendChild(blurLayer);

                    // Create reveal button
                    const revealButton = document.createElement('button');
                    const itemType = itemName === 'comments' ? 'comment' : 'video';
                    revealButton.textContent = `Reveal this ${itemType} + 4 nearby`;
                    revealButton.style.whiteSpace = 'nowrap';
                    revealButton.style.backgroundColor = '#065fd4';
                    revealButton.style.color = 'white';
                    revealButton.style.border = 'none';
                    revealButton.style.borderRadius = '2px';
                    revealButton.style.padding = '8px 14px';
                    revealButton.style.fontSize = '13px';
                    revealButton.style.cursor = 'pointer';

                    // Add pressAndHold behavior
                    revealButton.pressAndHold({ holdTime: __overlays_time });

                    // When button is held, remove this overlay and adjacent ones
                    revealButton.addEventListener('complete.pressAndHold', () => {
                        // Remove this overlay
                        overlay.remove();

                        // Find and remove adjacent overlays (2 above and 2 below)
                        const allItems = Array.from(container.querySelectorAll(itemSelector));
                        const currentIndex = allItems.indexOf(item);

                        // Function to get and remove adjacent overlays
                        const removeAdjacentOverlays = (itemIndex, direction, count) => {
                            for (let i = 1; i <= count; i++) {
                                const adjacentIndex = itemIndex + (direction * i);
                                if (adjacentIndex >= 0 && adjacentIndex < allItems.length) {
                                    const adjacentItem = allItems[adjacentIndex];
                                    const adjacentOverlay = adjacentItem.querySelector('.individual-item-overlay');
                                    if (adjacentOverlay) {
                                        adjacentOverlay.remove();
                                    }
                                }
                            }
                        };

                        // Remove 2 overlays above and 2 below
                        removeAdjacentOverlays(currentIndex, -1, 2); // Remove above
                        removeAdjacentOverlays(currentIndex, 1, 2);  // Remove below

                        console.log(`Revealed ${itemName} item at index ${currentIndex} and adjacent items`);
                    });

                    // Add button to overlay
                    overlay.appendChild(revealButton);

                    // Make sure the item has position relative for proper overlay positioning
                    const currentPosition = window.getComputedStyle(item).position;
                    if (currentPosition === 'static') {
                        item.style.position = 'relative';
                    }

                    // Add overlay to the item
                    item.appendChild(overlay);
                });

                console.log(`Added overlays to ${newItems.length} new ${itemName}`);
            }, 100);
        }
    });

    // Start observing the container for changes
    observer.observe(container, {
        childList: true,
        subtree: true
    });

    return observer;
}

// Main function to initialize overlays
async function initializeOverlays() {
    // Only run on YouTube
    if (window.location.hostname !== "www.youtube.com") {
        return;
    }

    // Check if we should run first-time setup
    const overlaysDisabled = await Cookies.get("overlays:isDisabled");
    if (overlaysDisabled === null) {
        // This would normally be a confirm dialog, but that could be annoying in an extension
        // So we'll default to not disabled
        Cookies.set("overlays:isDisabled", false);
    }

    // Handle watch pages
    if (window.location.pathname === "/watch") {
        // Original section overlays
        waitForElementToBeLoaded("#comments #comment", () => {
            addOverlay("#comments", "STOP! is it really worth it?", __overlays_time, () => {
                // After main overlay is removed, add individual overlays to each comment
                addIndividualOverlays("#comments", "ytd-comment-thread-renderer", "comments");
            });
        });

        waitForElementToBeLoaded("#related #items", () => {
            addOverlay("#related", "related videos", __overlays_time, () => {
                // After main overlay is removed, add individual overlays to each related video
                addIndividualOverlays("#related #items", "ytd-compact-video-renderer", "videos");
            });
        });
    }

    // Set up home page grid overlays observer
    if (window.location.pathname === "/") {
        // Debounce function implementation
        function debounce(func, wait) {
            let timeout;
            return function() {
                const context = this;
                const args = arguments;
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    func.apply(context, args);
                }, wait);
            };
        }

        // Set up the mutation observer
        const observer = new MutationObserver(onMutationsFinished);
        observer.observe(document, {subtree: true, childList: true});
    }
}
