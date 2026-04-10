let initializeOverlays = (function() {
    let {log, error} = initLogger("overlays")

    const OVERLAY_CONFIG = {
        "www.youtube.com": {
            globalStyles: '#contents { filter: grayscale(1); }',
            excludePaths: [/^\/embed/],
            overlays: [
                {
                    pathPattern: /\/(watch|live)/,
                    selector: "#comments #contents",
                    itemSelector: "ytd-comment-thread-renderer",
                    individual: true,
                    itemName: "comments",
                    adjacentRevealCount: 2,
                    holdTime: 3000,
                    blurEffect: true,
                    waitFor: true
                },
                {
                    pathPattern: /\/(watch|live)/,
                    selector: "ytd-watch-next-secondary-results-renderer",
                    itemSelector: "ytd-reel-shelf-renderer",
                    individual: true,
                    itemName: "recommendations",
                    adjacentRevealCount: 0,
                    holdTime: 3000,
                    blurEffect: true,
                    waitFor: true
                },
                {
                    pathPattern: /\/(watch|live)/,
                    selector: "ytd-watch-next-secondary-results-renderer #contents, ytd-watch-next-secondary-results-renderer #items",
                    itemSelector: "ytd-compact-video-renderer.ytd-watch-next-secondary-results-renderer, yt-lockup-view-model.ytd-item-section-renderer",
                    individual: true,
                    itemName: "videos",
                    adjacentRevealCount: 2,
                    holdTime: 3000,
                    blurEffect: true,
                    waitFor: true,
                    filterFunction: null  // Will be set dynamically
                }
            ]
        }
    };

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

    function closeTo(x, number, margin) {
        return x >= (number - margin) && x <= (number + margin)
    }

    function logSimplifiedHTML(element, itemSelector, maxDepth = 3) {
        function getElementSignature(el) {
            let sig = `<${el.tagName.toLowerCase()}`;
            if (el.id) sig += ` id="${el.id}"`;
            if (el.className) sig += ` class="${el.className}"`;
            sig += '>';
            return sig;
        }

        function buildTree(el, depth, indent = '') {
            if (depth > maxDepth) return [];

            const lines = [];
            const children = Array.from(el.children);
            const maxShow = 5;

            children.slice(0, maxShow).forEach(child => {
                const isMatch = itemSelector && child.matches(itemSelector);
                const prefix = isMatch ? '✓ ' : '  ';
                const suffix = isMatch ? ' [MATCH]' : '';
                lines.push(indent + prefix + getElementSignature(child) + suffix);

                if (depth < maxDepth) {
                    lines.push(...buildTree(child, depth + 1, indent + '  '));
                }
            });

            if (children.length > maxShow) {
                const remaining = children.length - maxShow;
                const remainingMatches = itemSelector
                    ? children.slice(maxShow).filter(c => c.matches(itemSelector))
                    : [];
                const matchInfo = remainingMatches.length > 0
                    ? ` (${remainingMatches.length} matches)`
                    : '';
                lines.push(indent + `  ... (${remaining} more${matchInfo})`);
            }

            return lines;
        }

        const output = [getElementSignature(element)];
        output.push(...buildTree(element, 1, '  '));

        log('[DEBUG] Container HTML structure:\n' + output.join('\n'));

        if (itemSelector) {
            const totalMatches = element.querySelectorAll(itemSelector).length;
            log(`[DEBUG] Total matches for "${itemSelector}": ${totalMatches}`);
        }
    }

    function addIndividualOverlays(containerSelector, itemSelector, config) {
        log(`[DEBUG] addIndividualOverlays called with:`, containerSelector, itemSelector, config);

        const container = document.querySelector(containerSelector);
        if (!container) {
            error(`[ERROR] Container ${containerSelector} not found`);
            return;
        }
        log(`[DEBUG] Container found:`, container);
        logSimplifiedHTML(container, itemSelector, 3);

        const itemName = config.itemName || 'items';
        const holdTime = config.holdTime || 3000;
        const adjacentRevealCount = config.adjacentRevealCount || 2;
        const filterFunction = config.filterFunction;
        const blurEffect = config.blurEffect || false;

        log(`[DEBUG] Adding individual overlays to ${itemName}`);

        // Get all items
        let allItems = Array.from(container.querySelectorAll(itemSelector));
        log(`[DEBUG] Found ${allItems.length} items before filtering`);

        if (filterFunction) {
            const beforeFilter = allItems.length;
            allItems = allItems.filter(filterFunction);
            log(`[DEBUG] Filtered from ${beforeFilter} to ${allItems.length} items`);
        }

        // Filter out items that have already been revealed
        const beforeRevealedFilter = allItems.length;
        allItems = allItems.filter(item => !item.classList.contains('revealed'));
        if (beforeRevealedFilter > allItems.length) {
            log(`[DEBUG] Filtered out ${beforeRevealedFilter - allItems.length} already-revealed items`);
        }

        if (allItems.length === 0) {
            error(`[ERROR] No ${itemName} found after filtering`);
            return;
        }

        log(`[DEBUG] Found ${allItems.length} ${itemName} to overlay`);

        // Apply blur effect if enabled - target child elements not the container
        if (blurEffect) {
            // Split comma-separated selectors and apply blur rules to each
            const selectors = itemSelector.split(',').map(s => s.trim());
            const blurTargets = ['#comment', 'img', 'h3', '#dismissible'];

            // Generate selectors for items that are NOT revealed (should be blurred)
            const notRevealedSelectors = selectors.flatMap(sel =>
                blurTargets.map(target => `${sel}:not(.revealed) ${target}`)
            ).join(',\n                ');

            // Generate selectors for revealed items (should NOT be blurred)
            const revealedSelectors = selectors.flatMap(sel =>
                blurTargets.map(target => `${sel}.revealed ${target}`)
            ).join(',\n                ');

            addGlobalStyle(`
                ${notRevealedSelectors} {
                    filter: blur(5px);
                    transition: filter 0.3s ease;
                }
                ${revealedSelectors} {
                    filter: none;
                }
                /* Ensure overlay stays sharp */
                .individual-item-overlay {
                    filter: none !important;
                }
            `);
        }

        // Add overlay to each item
        allItems.forEach((item, index) => {
            if (item.querySelector('.individual-item-overlay')) {
                return;
            }

            if (!item.id) {
                item.id = `${itemName}-item-${index}-${Date.now()}`;
            }

            // Create overlay for this item
            const overlay = document.createElement('div');
            overlay.className = 'individual-item-overlay';
            overlay.dataset.itemType = itemName;
            overlay.dataset.itemIndex = index;
            overlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background-color: rgba(0, 0, 0, 0.8);
                z-index: 2000;
                display: flex;
                align-items: center;
                justify-content: center;
                box-sizing: border-box;
                border: 2px solid #065fd4;
                min-height: 50px;
                backdrop-filter: blur(5px);
                -webkit-backdrop-filter: blur(5px);
            `;

            // Add a semi-transparent div to further obscure content
            const blurLayer = document.createElement('div');
            blurLayer.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background-color: rgba(255, 255, 255, 0.1);
            `;
            overlay.appendChild(blurLayer);

            // Create reveal button
            const revealButton = document.createElement('button');
            const itemType = itemName === 'comments' ? 'comment' : (itemName === 'videos' ? 'video' : 'item');
            revealButton.textContent = `Reveal this ${itemType} + ${adjacentRevealCount} below`;
            revealButton.style.cssText = `
                white-space: nowrap;
                background-color: #065fd4;
                color: white;
                border: none;
                border-radius: 4px;
                padding: 20px 30px;
                font-size: 16px;
                cursor: pointer;
                position: relative;
                z-index: 1;
            `;

            // Add pressAndHold behavior
            revealButton.pressAndHold({ holdTime: holdTime, isClickDisabled: true, progressMemory: "instance", progressIndicatorColor: "#ffffff", progressIndicatorOpacity: 0.4 });

            // When button is held, remove this overlay and adjacent ones
            revealButton.addEventListener('complete.pressAndHold', () => {
                // Remove this overlay
                overlay.remove();

                // Find and remove adjacent overlays
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
                            // Always mark as revealed to prevent re-adding overlay
                            adjacentItem.classList.add('revealed');
                        }
                    }
                };

                removeAdjacentOverlays(currentIndex, 1, adjacentRevealCount);  // Remove below

                // Always mark as revealed to prevent re-adding overlay
                item.classList.add('revealed');

                log(`Revealed ${itemName} item at index ${currentIndex} and adjacent items`);
            });

            // Add button to overlay
            overlay.appendChild(revealButton);

            // Make sure the item has position relative for proper overlay positioning
            const currentPosition = window.getComputedStyle(item).position;
            if (currentPosition === 'static') {
                item.style.position = 'relative';
            }

            log('[DEBUG] Appending overlay to', item);
            item.appendChild(overlay);
            log(`[DEBUG] Overlay appended. Item now has ${item.children.length} children`);
        });

        log(`[DEBUG] Added overlays to ${allItems.length} ${itemName}`);

        // Set up mutation observer for dynamically added items
        const observer = new MutationObserver(debounce(100, () => {
            log(`[DEBUG] Mutation detected in ${itemName} container`);
            let newItems = Array.from(container.querySelectorAll(itemSelector))
                .filter(item => !item.querySelector('.individual-item-overlay'))
                .filter(item => !item.classList.contains('revealed'));

            log(`[DEBUG] Found ${newItems.length} items without overlays (after filtering revealed items)`);

            if (filterFunction) {
                const beforeFilter = newItems.length;
                newItems = newItems.filter(filterFunction);
                log(`[DEBUG] Filtered from ${beforeFilter} to ${newItems.length} new items`);
            }

            if (newItems.length === 0) {
                log(`[DEBUG] No new ${itemName} to add overlays to`);
                return;
            }

            log(`[DEBUG] Adding overlays to ${newItems.length} new ${itemName}`);

            newItems.forEach((item, index) => {
                if (!item.id) {
                    item.id = `${itemName}-item-new-${index}-${Date.now()}`;
                }

                const overlay = document.createElement('div');
                overlay.className = 'individual-item-overlay';
                overlay.dataset.itemType = itemName;
                overlay.dataset.itemIndex = index;
                overlay.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0, 0, 0, 0.8);
                    z-index: 2000;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    box-sizing: border-box;
                    border: 2px solid #065fd4;
                    min-height: 50px;
                    backdrop-filter: blur(5px);
                    -webkit-backdrop-filter: blur(5px);
                `;

                const blurLayer = document.createElement('div');
                blurLayer.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(255, 255, 255, 0.1);
                `;
                overlay.appendChild(blurLayer);

                const revealButton = document.createElement('button');
                const itemType = itemName === 'comments' ? 'comment' : (itemName === 'videos' ? 'video' : 'item');
                revealButton.textContent = `Reveal this ${itemType} + ${adjacentRevealCount} below`;
                revealButton.style.cssText = `
                    white-space: nowrap;
                    background-color: #065fd4;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    padding: 20px 30px;
                    font-size: 16px;
                    cursor: pointer;
                    position: relative;
                    z-index: 1;
                `;

                revealButton.pressAndHold({ holdTime: holdTime, isClickDisabled: true, progressMemory: "instance", progressIndicatorColor: "#ffffff", progressIndicatorOpacity: 0.4 });

                revealButton.addEventListener('complete.pressAndHold', () => {
                    overlay.remove();

                    const allItems = Array.from(container.querySelectorAll(itemSelector));
                    const currentIndex = allItems.indexOf(item);

                    const removeAdjacentOverlays = (itemIndex, direction, count) => {
                        for (let i = 1; i <= count; i++) {
                            const adjacentIndex = itemIndex + (direction * i);
                            if (adjacentIndex >= 0 && adjacentIndex < allItems.length) {
                                const adjacentItem = allItems[adjacentIndex];
                                const adjacentOverlay = adjacentItem.querySelector('.individual-item-overlay');
                                if (adjacentOverlay) {
                                    adjacentOverlay.remove();
                                }
                                // Always mark as revealed to prevent re-adding overlay
                                adjacentItem.classList.add('revealed');
                            }
                        }
                    };

                    removeAdjacentOverlays(currentIndex, 1, adjacentRevealCount);

                    // Always mark as revealed to prevent re-adding overlay
                    item.classList.add('revealed');

                    log(`Revealed ${itemName} item at index ${currentIndex} and adjacent items`);
                });

                overlay.appendChild(revealButton);

                const currentPosition = window.getComputedStyle(item).position;
                if (currentPosition === 'static') {
                    item.style.position = 'relative';
                }

                item.appendChild(overlay);
            });
        }));

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

    // Process overlays from configuration
    function processOverlayConfig(siteConfig) {
        if (!siteConfig) return;

        // Check if current path is excluded
        if (siteConfig.excludePaths) {
            for (let pattern of siteConfig.excludePaths) {
                if (window.location.pathname.match(pattern)) {
                    log('[DEBUG] Path excluded, skipping overlays');
                    return;
                }
            }
        }

        // Apply global styles
        if (siteConfig.globalStyles) {
            addGlobalStyle(siteConfig.globalStyles);
            log('[DEBUG] Applied global styles');
        }

        // Process overlay configurations
        if (siteConfig.overlays) {
            siteConfig.overlays.forEach(overlayConfig => {
                log(`[DEBUG] Processing overlay config:`, overlayConfig);

                // Check if overlay applies to current path
                if (overlayConfig.path && window.location.pathname !== overlayConfig.path) {
                    log(`[DEBUG] Skipping - path mismatch: ${window.location.pathname} !== ${overlayConfig.path}`);
                    return;
                }
                if (overlayConfig.pathPattern && !window.location.pathname.match(overlayConfig.pathPattern)) {
                    log(`[DEBUG] Skipping - path pattern mismatch`);
                    return;
                }

                // Add the overlay
                if (overlayConfig.individual) {
                    log(`[DEBUG] Individual overlay mode for ${overlayConfig.itemName}`);

                    if (overlayConfig.waitFor) {
                        log(`[DEBUG] Waiting for: ${overlayConfig.selector}`);
                        // Wait for container to have matching items
                        const validation = (container) => {
                            const itemCount = container.querySelectorAll(overlayConfig.itemSelector).length;
                            log(`[DEBUG] Validation check - found ${itemCount} ${overlayConfig.itemSelector} in container`);
                            return itemCount > 0;
                        };
                        waitForElementToBeLoaded(overlayConfig.selector, () => {
                            log(`[DEBUG] Element loaded with items, calling addIndividualOverlays`);
                            addIndividualOverlays(overlayConfig.selector, overlayConfig.itemSelector, overlayConfig);
                        }, validation);
                    } else {
                        log(`[DEBUG] No wait, calling addIndividualOverlays immediately`);
                        addIndividualOverlays(overlayConfig.selector, overlayConfig.itemSelector, overlayConfig);
                    }
                }
            });
        }
    }

    function MAIN() {
        // Process config-driven overlays
        const siteConfig = OVERLAY_CONFIG[window.location.host];
        processOverlayConfig(siteConfig);
    }

    var lastUrl = null;

    var onMutationsFinished = debounce(100, function() {
        if (lastUrl !== location.href || !lastUrl) {
            lastUrl = location.href;
            log('[DEBUG] URL changed to:', lastUrl);
            MAIN();
        }
    });

    async function initializeOverlays() {
        if (window.location.hostname !== "www.youtube.com") {
            return;
        }

        log("Initializing YouTube overlays");

        // Make sure overlay is visible on top of blur
        addGlobalStyle(`
        .individual-item-overlay {
            pointer-events: auto !important;
        }
    `);

        log("Added global overlay styles");

        const observer = new MutationObserver(onMutationsFinished);
        observer.observe(document, {subtree: true, childList: true});
    }

    return initializeOverlays
})();
