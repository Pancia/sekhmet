const __overlays_time = 3000;

function addGlobalStyle(css) {
    const head = document.getElementsByTagName('head')[0];
    if (!head) { return; }

    const style = document.createElement('style');
    style.type = 'text/css';
    style.innerHTML = css;
    head.appendChild(style);
}

function displayTime(date) {
    return new Date(Number(date)).toLocaleTimeString("en-US", { hour: "numeric", minute: "numeric", hourCycle: "h24"});
}

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

    console.log("The blur is causing issues with overlays - making items visible for overlay placement");
    // Temporarily remove blur class to add overlays
    addGlobalStyle(`
        ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer {
            filter: none !important;
        }
    `);

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
                        // Remove blur by adding revealed class
                        adjacentItem.classList.add('revealed');
                    }
                }
            };

            // removeAdjacentOverlays(currentIndex, -1, 2); // Remove above
            removeAdjacentOverlays(currentIndex, 1, 2);  // Remove below

            // Remove blur from current item
            item.classList.add('revealed');

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

    // Re-apply blur to items without overlays
    setTimeout(() => {
        addGlobalStyle(`
            ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer {
                filter: blur(5px);
            }
            ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer.revealed {
                filter: none;
            }
        `);
        console.log("Re-applied blur to items");
    }, 500);

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

                // Temporarily remove blur for overlay placement
                addGlobalStyle(`
                    ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer {
                        filter: none !important;
                    }
                `);

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
                                    // Remove blur by adding revealed class
                                    adjacentItem.classList.add('revealed');
                                }
                            }
                        };

                        // Remove 2 overlays above and 2 below
                        removeAdjacentOverlays(currentIndex, -1, 2); // Remove above
                        removeAdjacentOverlays(currentIndex, 1, 2);  // Remove below

                        // Remove blur from current item
                        item.classList.add('revealed');

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

                // Re-apply blur to items without overlays
                setTimeout(() => {
                    addGlobalStyle(`
                        ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer {
                            filter: blur(5px);
                        }
                        ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer.revealed {
                            filter: none;
                        }
                    `);
                }, 200);
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

function debounce(wait, func) {
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

var __once = false;

var onMutationsFinished = debounce(100, function() {
    if (__once == false) {
        __once = true;
    } else {
        return
    }
    if (window.location.pathname === "/watch") {
        waitForElementToBeLoaded("#comments #comment", () => {
            addIndividualOverlays("#comments", "ytd-comment-thread-renderer", "comments");
        });

        // Try different selectors to make sure we find the videos
        waitForElementToBeLoaded("ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer", () => {
            console.log("Found related videos, adding overlays");
            addIndividualOverlays("ytd-watch-next-secondary-results-renderer", "ytd-compact-video-renderer", "videos");
        });
    }
})

async function initializeOverlays() {
    if (window.location.hostname !== "www.youtube.com") {
        return;
    }

    console.log("Initializing YouTube overlays");

    // Add blur effect on related videos as soon as possible
    addGlobalStyle(`
        ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer {
            filter: blur(5px);
            transition: filter 0.3s ease;
        }
        ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer.revealed {
            filter: none;
        }
        /* Make sure overlay is visible on top of blur */
        .individual-item-overlay {
            z-index: 10000 !important;
            pointer-events: auto !important;
        }
    `);

    console.log("Added blur style to related videos");

    const observer = new MutationObserver(onMutationsFinished);
    observer.observe(document, {subtree: true, childList: true});
}
