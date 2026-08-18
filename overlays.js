let initializeOverlays = (function() {
    let {log, error} = initLogger("overlays")

    const OVERLAY_CONFIG = {
        "www.youtube.com": {
            globalStyles: '#contents { filter: grayscale(1); }',
            excludePaths: [/^\/embed/],
            overlays: [
                {
                    // The home grid gets the comments treatment, one overlay per row.
                    // Both selectors are scoped to page-subtype=home rather than
                    // leaning on pathPattern alone: the blur stylesheet is injected
                    // once and never removed, and subscriptions / channel pages are
                    // built from the same rich-grid markup, so an unscoped rule would
                    // blur those too - with no button anywhere to clear it.
                    pathPattern: /^\/$/,
                    selector: "ytd-browse[page-subtype='home'] ytd-rich-grid-renderer > #contents",
                    itemSelector: "ytd-browse[page-subtype='home'] ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer, ytd-browse[page-subtype='home'] ytd-rich-grid-renderer > #contents > ytd-rich-section-renderer",
                    rows: true,
                    itemName: "rows",
                    holdTime: 3000,
                    blurEffect: true,
                    waitFor: true
                },
                {
                    // The gate: one overlay over the player itself, once per video.
                    // Attached inside #movie_player rather than to #player so it
                    // follows the player into theater and fullscreen, both of which
                    // move the element into a different container.
                    pathPattern: /\/(watch|live)/,
                    selector: "#movie_player",
                    singular: true,
                    message: "STOP! is it really worth it?",
                    buttonText: "Hold to watch",
                    // 10s, the same hold the feeling tracker asks for.
                    holdTime: 10000,
                    pauseWhileCovered: true,
                    waitFor: true
                },
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

    // Fast early, calm later. The first ~3s at 50ms is what makes an overlay land as
    // soon as its container appears; past that we are almost certainly waiting on
    // something this page simply does not have - most watch pages have no Shorts
    // shelf - so back off rather than forcing a layout once a second for the whole
    // video. Teardown stops these on navigation; the backoff bounds the survivor.
    const POLL_CONFIG = { initialWait: 50, increaseAfter: 60, increaseBy: 1.2, maxWait: 5000 };

    // id is optional but worth passing: MAIN() re-runs on every SPA navigation, and
    // without it each one appends another copy of the same rules.
    function addGlobalStyle(css, id) {
        const head = document.getElementsByTagName('head')[0];
        if (!head) { return; }
        if (id && document.getElementById(id)) { return; }

        const style = document.createElement('style');
        style.type = 'text/css';
        if (id) { style.id = id; }
        style.innerHTML = css;
        head.appendChild(style);
    }

    // Built from static config alone, so it can go in the moment we know the path
    // matches - no waiting on the container. That matters: until this lands, comments
    // render unobscured, and YouTube takes seconds to stream them in.
    function addBlurStyle(itemSelector, itemName) {
        const selectors = itemSelector.split(',').map(s => s.trim());

        // filter rasterizes the entire subtree, so an ancestor's blur cannot be undone
        // further down. Items nest (replies live inside their thread), so any child
        // holding another item's overlay is exempted - otherwise we blur that item's
        // reveal button along with it. The exemption is a class put on from JS
        // (markOverlayHost) rather than the ":has(.individual-item-overlay)" it used to
        // be, because :has stops matching the moment that nested overlay is revealed
        // away - which put the blur straight back over the reply just revealed.
        const hidden = selectors.map(sel =>
            `${sel}:not(.revealed) > *:not(.individual-item-overlay):not(.yte-overlay-host)`
        ).join(',\n            ');

        const revealed = selectors.map(sel =>
            `${sel}.revealed > *`
        ).join(',\n            ');

        // !important because of our own globalStyles rule: a bare "#contents" is an id,
        // so it outranks anything here on specificity, and YouTube ids its wrapper divs
        // freely. Costs nothing - the greyscale is rasterized by an ancestor either way,
        // so a descendant filter could never have brought the colour back.
        addGlobalStyle(`
            ${hidden} {
                filter: blur(5px) !important;
            }
            ${revealed} {
                filter: none !important;
                transition: filter 0.3s ease;
            }
            /* Ensure overlay stays sharp */
            .individual-item-overlay {
                filter: none !important;
            }
        `, `yte-blur-${itemName}`);
    }

    // itemName is a plural collective; the button talks about one of them.
    const ITEM_TYPES = { comments: 'comment', videos: 'video', rows: 'row' };

    function revealLabel(itemName, adjacentRevealCount) {
        const itemType = ITEM_TYPES[itemName] || 'item';
        return adjacentRevealCount > 0
            ? `Reveal this ${itemType} + ${adjacentRevealCount} below`
            : `Reveal this ${itemType}`;
    }

    function displayTime(date) {
        return new Date(Number(date)).toLocaleTimeString("en-US", { hour: "numeric", minute: "numeric", hourCycle: "h24"});
    }

    function closeTo(x, number, margin) {
        return x >= (number - margin) && x <= (number + margin)
    }

    // Everything MAIN() wires up belongs to the page it ran on: container observers,
    // container polls, window listeners, the player gate. YouTube is an SPA, so
    // without this they accumulate a full set per navigation - all still firing, and
    // most still bound to containers YouTube has since recycled into the new page's
    // content. Ten videos in, one comment batch triggers ten independent rescans.
    let pageTeardowns = [];

    function onTeardown(fn) {
        if (typeof fn === 'function') { pageTeardowns.push(fn); }
    }

    function teardownPage() {
        const pending = pageTeardowns;
        pageTeardowns = [];

        pending.forEach(fn => {
            try {
                fn();
            } catch (e) {
                error('[ERROR] Teardown step failed:', e);
            }
        });

        if (pending.length) {
            log(`[DEBUG] Tore down ${pending.length} page-scoped resources`);
        }
    }

    // Items nest - a comment thread's replies are threads in their own right - so
    // "adjacent" has to mean "same nesting level", not "next in document order".
    // Group by the nearest enclosing item (null at top level) rather than by shared
    // parentElement: YouTube puts wrapper divs of its own between an item and the
    // next one, which would leave every reply alone in its own list.
    function siblingItems(container, item, itemSelector) {
        const enclosingItem = (el) =>
            el.parentElement ? el.parentElement.closest(itemSelector) : null;
        const enclosing = enclosingItem(item);

        return Array.from(container.querySelectorAll(itemSelector))
            .filter(el => enclosingItem(el) === enclosing);
    }

    // Exempt from the blur the one child of the enclosing item that this item sits
    // inside, so a nested item's overlay does not get rasterized along with its
    // parent's content. See addBlurStyle for why this is a class and not :has().
    function markOverlayHost(item, itemSelector) {
        const enclosing = item.parentElement ? item.parentElement.closest(itemSelector) : null;
        if (!enclosing) { return; }

        let node = item;
        while (node.parentElement && node.parentElement !== enclosing) {
            node = node.parentElement;
        }
        if (node.parentElement === enclosing) {
            node.classList.add('yte-overlay-host');
        }
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

        // Empty is not fatal, and must not skip the observer below: blur goes on as
        // soon as the path matches, so bailing here would leave content blurred with
        // no reveal button on it.
        if (allItems.length === 0) {
            log(`[DEBUG] No ${itemName} to overlay yet, waiting on the observer`);
        }

        log(`[DEBUG] Found ${allItems.length} ${itemName} to overlay`);

        // Blur is already in place - addBlurStyle runs as soon as the path matches,
        // without waiting for the container. All that is left here is the overlay box.

        // Add overlay to each item
        allItems.forEach((item, index) => {
            // :scope > - items nest, and querySelector is depth-first, so a bare
            // lookup finds a nested reply's overlay before the item's own.
            if (item.querySelector(':scope > .individual-item-overlay')) {
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
            revealButton.textContent = revealLabel(itemName, adjacentRevealCount);
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

                // Find and remove adjacent overlays. Adjacency is per nesting level:
                // a document-order list puts a thread's own replies between it and the
                // next top-level comment, so "+ 2 below" would reveal into the replies.
                const siblings = siblingItems(container, item, itemSelector);
                const currentIndex = siblings.indexOf(item);

                // Function to get and remove adjacent overlays
                const removeAdjacentOverlays = (itemIndex, direction, count) => {
                    for (let i = 1; i <= count; i++) {
                        const adjacentIndex = itemIndex + (direction * i);
                        if (adjacentIndex >= 0 && adjacentIndex < siblings.length) {
                            const adjacentItem = siblings[adjacentIndex];
                            const adjacentOverlay = adjacentItem.querySelector(':scope > .individual-item-overlay');
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
            markOverlayHost(item, itemSelector);
            log(`[DEBUG] Overlay appended. Item now has ${item.children.length} children`);
        });

        log(`[DEBUG] Added overlays to ${allItems.length} ${itemName}`);

        // Set up mutation observer for dynamically added items
        const observer = new MutationObserver(throttle(100, () => {
            log(`[DEBUG] Mutation detected in ${itemName} container`);
            let newItems = Array.from(container.querySelectorAll(itemSelector))
                .filter(item => !item.querySelector(':scope > .individual-item-overlay'))
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
                revealButton.textContent = revealLabel(itemName, adjacentRevealCount);
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

                    const siblings = siblingItems(container, item, itemSelector);
                    const currentIndex = siblings.indexOf(item);

                    const removeAdjacentOverlays = (itemIndex, direction, count) => {
                        for (let i = 1; i <= count; i++) {
                            const adjacentIndex = itemIndex + (direction * i);
                            if (adjacentIndex >= 0 && adjacentIndex < siblings.length) {
                                const adjacentItem = siblings[adjacentIndex];
                                const adjacentOverlay = adjacentItem.querySelector(':scope > .individual-item-overlay');
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
                markOverlayHost(item, itemSelector);
            });
        }));

        // Start observing the container for changes
        observer.observe(container, {
            childList: true,
            subtree: true
        });
        onTeardown(() => observer.disconnect());

        return observer;
    }

    // YouTube dropped ytd-rich-grid-row: the home feed is now a flat list of cards
    // that CSS lays out in a grid, so a "row" exists only visually. Recover it from
    // layout - cards sharing an offsetTop are one row - which also handles the
    // full-width shelves, since those come out as rows of one.
    //
    // The overlay is a child of the grid container rather than of any card: one bar
    // spanning the row, repositioned whenever the grid reflows.
    function addRowOverlays(containerSelector, itemSelector, config) {
        const container = document.querySelector(containerSelector);
        if (!container) {
            error(`[ERROR] Container ${containerSelector} not found`);
            return;
        }

        // MAIN() re-runs on every SPA navigation; the observers below outlive it.
        if (container.dataset.yteRowOverlays) {
            log('[DEBUG] Row overlays already wired to this container');
            return;
        }
        container.dataset.yteRowOverlays = 'true';

        const itemName = config.itemName || 'rows';
        const holdTime = config.holdTime || 3000;

        // Absolute positioning and offsetTop have to share a coordinate system.
        // Making the container the offsetParent gives us both at once - and it has
        // to happen before anything is measured.
        if (window.getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        const overlays = new Map();   // row-leading card -> its overlay

        function currentRows() {
            // Anything without a layout box is not on any row. YouTube keeps hidden
            // slots (ads, promos, items it has not committed to rendering) in the
            // grid, and those all report an offsetTop of 0 - which invented a
            // zero-height row per slot at the very top of the feed, each one a
            // button floating over the chips bar that revealed nothing.
            const items = Array.from(container.children).filter(el =>
                el.matches(itemSelector) && el.offsetParent !== null && el.offsetHeight > 0
            );
            const rows = [];

            for (const item of items) {
                const top = item.offsetTop;
                const row = rows[rows.length - 1];
                // Cards in a row line up exactly; rows sit hundreds of px apart. The
                // slack is only there to absorb sub-pixel rounding.
                if (row && closeTo(top, row.top, 4)) {
                    row.items.push(item);
                    row.height = Math.max(row.height, item.offsetHeight);
                } else {
                    rows.push({ top: top, height: item.offsetHeight, items: [item] });
                }
            }

            return rows;
        }

        function buildRowOverlay() {
            const overlay = document.createElement('div');
            overlay.className = 'row-overlay';
            overlay.style.cssText = `
                position: absolute;
                left: 0;
                right: 0;
                background-color: rgba(0, 0, 0, 0.8);
                z-index: 2000;
                display: flex;
                align-items: center;
                justify-content: center;
                box-sizing: border-box;
                border: 2px solid #065fd4;
                backdrop-filter: blur(5px);
                -webkit-backdrop-filter: blur(5px);
            `;

            const revealButton = document.createElement('button');
            revealButton.textContent = revealLabel(itemName, 0);
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
                // Read at completion rather than at creation: a reflow can have
                // regrouped the row under this overlay since it was built.
                const revealed = overlay.rowItems || [];
                revealed.forEach(el => el.classList.add('revealed'));

                overlays.forEach((value, leader) => {
                    if (value === overlay) { overlays.delete(leader); }
                });
                overlay.remove();

                log(`Revealed a row of ${revealed.length} ${itemName === 'rows' ? 'items' : itemName}`);
            });

            overlay.appendChild(revealButton);
            return overlay;
        }

        // Every measurement happens in currentRows() before a single style is
        // written, so a pass costs one reflow rather than one per row.
        function layout() {
            const rows = currentRows();
            const leaders = new Set();

            rows.forEach(row => {
                // A bar with no height still shows its button, which would sit over
                // whatever happens to be above the feed.
                if (row.height <= 0) { return; }
                if (row.items.every(el => el.classList.contains('revealed'))) { return; }

                const leader = row.items[0];
                leaders.add(leader);

                let overlay = overlays.get(leader);
                if (!overlay) {
                    overlay = buildRowOverlay();
                    overlays.set(leader, overlay);
                }

                // Re-attach rather than assume it is still in the DOM. YouTube owns
                // this container and reaps children it did not put there, so a bar
                // we reuse - which is every bar whose row kept its leading card
                // across a reflow - is often detached by the time we get back to it.
                if (!overlay.isConnected) {
                    container.appendChild(overlay);
                }

                overlay.rowItems = row.items;
                overlay.style.top = `${row.top}px`;
                overlay.style.height = `${row.height}px`;
            });

            // Whatever no longer leads a row: revealed, regrouped by a resize, or
            // dropped from the feed entirely.
            overlays.forEach((overlay, leader) => {
                if (!leaders.has(leader)) {
                    overlay.remove();
                    overlays.delete(leader);
                }
            });
        }

        const relayout = throttle(150, layout);

        // childList without subtree: cards arrive as direct children as the feed
        // pages in. Everything else that moves a row - thumbnails settling, a title
        // wrapping to two lines, the guide opening - changes the container's own
        // height or width, which is what the ResizeObserver is for. The window
        // listener is belt and braces for the plain-resize case.
        const rowsObserver = new MutationObserver(relayout);
        const rowsResize = new ResizeObserver(relayout);

        rowsObserver.observe(container, { childList: true });
        rowsResize.observe(container);
        window.addEventListener('resize', relayout);

        onTeardown(() => {
            rowsObserver.disconnect();
            rowsResize.disconnect();
            window.removeEventListener('resize', relayout);
        });

        layout();
        log(`[DEBUG] Row overlays wired to ${containerSelector}`);
    }

    // One gate per video, keyed by video id. Both halves of that matter: MAIN() re-runs
    // on any URL change - a "&t=" stamp from a share link is enough - and a gate that
    // came back mid-video would be worse than no gate at all.
    //
    // Cleared gates outlive the page. A reload, a tab the browser unloaded under
    // memory pressure, or the same video opened again in a fresh tab all used to
    // ask again, which is the gate punishing a decision that was already made.
    // storage.local holds one object of video id -> cleared-at, so the answer
    // follows the video rather than the tab. The TTL keeps that from becoming
    // permanent: a video you sat through last month gets to ask once more.
    const GATE_STORAGE_KEY = 'yte_clearedGates';
    const GATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

    // videoId -> cleared-at timestamp. Hydrated from storage below; the in-memory
    // copy is what the gate actually reads, because the check has to be synchronous.
    const clearedGates = new Map();
    let activeGate = null;

    function gateKey() {
        const id = new URLSearchParams(window.location.search).get('v');
        return id || window.location.pathname;
    }

    // Storage is unreachable after the extension is reloaded or updated with pages
    // still open. Failing to in-memory-only there means the gate behaves as it did
    // before any of this - annoying at worst, never open when it should be shut.
    function gatesStorageUsable() {
        try {
            return !!(browser && browser.runtime && browser.runtime.id);
        } catch (e) {
            return false;
        }
    }

    // Read-merge-write rather than a straight set: another tab may have cleared a
    // gate since this page hydrated, and a blind write would drop it. Pruning rides
    // along, since this is the only thing that writes and entries only ever leave by
    // ageing out.
    function persistClearedGates() {
        if (!gatesStorageUsable()) { return Promise.resolve(); }

        const now = Date.now();
        return Cookies.get(GATE_STORAGE_KEY).then(stored => {
            const merged = {};
            const keep = (key, at) => {
                if (typeof at === 'number' && now - at < GATE_TTL_MS) {
                    merged[key] = Math.max(at, merged[key] || 0);
                }
            };

            Object.entries(stored || {}).forEach(([key, at]) => keep(key, at));
            clearedGates.forEach((at, key) => keep(key, at));

            return Cookies.set(GATE_STORAGE_KEY, merged);
        }).catch(err => {
            error(`[ERROR] Could not persist cleared gates: ${err}`);
        });
    }

    function rememberGateCleared(key) {
        clearedGates.set(key, Date.now());
        persistClearedGates();
    }

    // Started at load, not at first gate: the read is a round trip to the background
    // page, while the gate goes up the moment #movie_player has a <video>. Usually the
    // read wins and nothing flashes; when it does not, the then() below takes the gate
    // back down. Racing it the other way - waiting for storage before deciding - would
    // leave the player uncovered and playing in exactly the case the gate exists for.
    const gatesHydrated = (gatesStorageUsable()
        ? Cookies.get(GATE_STORAGE_KEY)
        : Promise.resolve(null)
    ).then(stored => {
        const now = Date.now();
        Object.entries(stored || {}).forEach(([key, at]) => {
            if (typeof at === 'number' && now - at < GATE_TTL_MS) {
                clearedGates.set(key, at);
            }
        });
        log(`[DEBUG] Restored ${clearedGates.size} cleared gates`);
    }).catch(err => {
        error(`[ERROR] Could not read cleared gates: ${err}`);
    });

    gatesHydrated.then(() => {
        if (activeGate && clearedGates.has(activeGate.key)) {
            log(`Gate for ${activeGate.key} was cleared previously, standing down`);
            activeGate.clear();
        }
    });

    // Unlike addIndividualOverlays, this is a single overlay covering the whole
    // container - no item list, no adjacency, nothing to observe for new arrivals.
    function addSingularOverlay(containerSelector, config) {
        const key = gateKey();

        if (clearedGates.has(key)) {
            log(`[DEBUG] Gate already cleared for ${key}`);
            return;
        }
        if (activeGate && activeGate.key === key) {
            log(`[DEBUG] Gate already up for ${key}`);
            return;
        }

        const container = document.querySelector(containerSelector);
        if (!container) {
            error(`[ERROR] Container ${containerSelector} not found`);
            return;
        }

        // Left over from the previous video: the player element survives SPA
        // navigation, so its gate does too unless we take it down.
        if (activeGate) {
            activeGate.teardown();
            activeGate = null;
        }
        container.querySelectorAll(':scope > .singular-overlay').forEach(el => el.remove());

        const holdTime = config.holdTime || 3000;

        const overlay = document.createElement('div');
        overlay.className = 'singular-overlay';
        overlay.dataset.gateKey = key;
        overlay.style.cssText = `
            position: absolute;
            inset: 0;
            background-color: rgba(0, 0, 0, 0.94);
            z-index: 2000;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 24px;
            box-sizing: border-box;
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
        `;

        const message = document.createElement('div');
        message.textContent = config.message || 'Is it really worth it?';
        message.style.cssText = `
            color: #ffffff;
            font-family: Roboto, Arial, sans-serif;
            font-size: 24px;
            font-weight: 500;
            text-align: center;
            padding: 0 20px;
        `;
        overlay.appendChild(message);

        const revealButton = document.createElement('button');
        revealButton.textContent = config.buttonText || 'Hold to watch';
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

        // Covering the player is only half of it - the audio would carry on behind
        // the overlay otherwise, which is most of what makes autoplay hard to leave.
        const video = container.querySelector('video');
        const keepPaused = () => { if (video && !video.paused) { video.pause(); } };
        if (config.pauseWhileCovered && video) {
            video.addEventListener('play', keepPaused);
            keepPaused();
        }

        let disposed = false;

        // The player rebuilds its own DOM as it pleases. If it takes the gate with
        // it, put it back rather than quietly leaving the video open. Checked on the
        // flag as well as the observer: throttle has a trailing edge, so a callback
        // can still be in flight when we disconnect.
        const guard = new MutationObserver(throttle(200, () => {
            if (disposed || clearedGates.has(key)) { return; }
            if (!overlay.isConnected && container.isConnected) {
                log('[DEBUG] Gate was removed by the player, re-attaching');
                container.appendChild(overlay);
            }
        }));

        const teardown = () => {
            disposed = true;
            guard.disconnect();
            if (video) { video.removeEventListener('play', keepPaused); }
            overlay.remove();
        };

        // Taking the gate down, whether the hold earned it or the store says a previous
        // one already did. The play() matters in both cases: without a gate the player
        // would have autoplayed, so leaving it paused would be a different behaviour
        // rather than an absent one.
        const clearGate = () => {
            teardown();
            activeGate = null;

            if (config.pauseWhileCovered && video && video.paused) {
                const played = video.play();
                if (played && played.catch) { played.catch(() => {}); }
            }
        };

        revealButton.addEventListener('complete.pressAndHold', () => {
            rememberGateCleared(key);
            clearGate();
            log(`Gate cleared for ${key}`);
        });

        overlay.appendChild(revealButton);

        // The player treats a click anywhere on itself as play/pause. The button's own
        // mousedown handler has already run by the time this fires, so swallowing here
        // costs nothing and stops the gate from toggling playback underneath it.
        ['mousedown', 'mouseup', 'click', 'dblclick'].forEach(type => {
            overlay.addEventListener(type, e => e.stopPropagation());
        });

        if (window.getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        container.appendChild(overlay);
        guard.observe(container, { childList: true });
        activeGate = { key, overlay, teardown, clear: clearGate };

        // Navigating away has to take the gate with it. Without this the guard keeps
        // re-attaching an overlay for the previous video, and a same-video URL change
        // (a "&t=" stamp) would raise a second gate over the top of the first.
        onTeardown(() => {
            teardown();
            activeGate = null;
        });

        log(`[DEBUG] Gate raised over ${containerSelector} for ${key}`);
    }

    // Debounce is wrong for a stream: YouTube adds comments in a steady trickle, each
    // batch resetting the timer, so overlays only land once the whole list has settled.
    // Throttle handles the first batch immediately and then at most once per window,
    // so a comment gets its overlay as it arrives rather than at the end.
    function throttle(wait, func) {
        let lastRun = 0;
        let timeout = null;

        return function() {
            const context = this;
            const args = arguments;
            const remaining = wait - (Date.now() - lastRun);

            if (remaining <= 0) {
                if (timeout) { clearTimeout(timeout); timeout = null; }
                lastRun = Date.now();
                func.apply(context, args);
            } else if (!timeout) {
                timeout = setTimeout(() => {
                    lastRun = Date.now();
                    timeout = null;
                    func.apply(context, args);
                }, remaining);
            }
        };
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
            addGlobalStyle(siteConfig.globalStyles, 'yte-global-styles');
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

                // Blur first, and without waiting for anything - the rules are pure
                // config, and every ms before they land is a ms of readable content.
                if (overlayConfig.blurEffect) {
                    addBlurStyle(overlayConfig.itemSelector, overlayConfig.itemName || 'items');
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
                        onTeardown(waitForElementToBeLoaded(overlayConfig.selector, () => {
                            log(`[DEBUG] Element loaded with items, calling addIndividualOverlays`);
                            addIndividualOverlays(overlayConfig.selector, overlayConfig.itemSelector, overlayConfig);
                        }, validation, POLL_CONFIG));
                    } else {
                        log(`[DEBUG] No wait, calling addIndividualOverlays immediately`);
                        addIndividualOverlays(overlayConfig.selector, overlayConfig.itemSelector, overlayConfig);
                    }
                }

                if (overlayConfig.rows) {
                    log(`[DEBUG] Row overlay mode for ${overlayConfig.itemName}`);

                    const validation = (container) =>
                        container.querySelectorAll(overlayConfig.itemSelector).length > 0;

                    if (overlayConfig.waitFor) {
                        onTeardown(waitForElementToBeLoaded(overlayConfig.selector, () => {
                            addRowOverlays(overlayConfig.selector, overlayConfig.itemSelector, overlayConfig);
                        }, validation, POLL_CONFIG));
                    } else {
                        addRowOverlays(overlayConfig.selector, overlayConfig.itemSelector, overlayConfig);
                    }
                }

                if (overlayConfig.singular) {
                    log(`[DEBUG] Singular overlay mode for ${overlayConfig.selector}`);

                    if (overlayConfig.waitFor) {
                        // Wait for the video element too, not just the container: the
                        // gate has nothing to hold paused until the player has one.
                        const validation = (container) => !!container.querySelector('video');
                        onTeardown(waitForElementToBeLoaded(overlayConfig.selector, () => {
                            addSingularOverlay(overlayConfig.selector, overlayConfig);
                        }, validation, POLL_CONFIG));
                    } else {
                        addSingularOverlay(overlayConfig.selector, overlayConfig);
                    }
                }
            });
        }
    }

    function MAIN() {
        // Retire the previous page's wiring before laying down this page's. MAIN() runs
        // per navigation, and everything below is scoped to the page that set it up.
        teardownPage();

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
        .individual-item-overlay,
        .row-overlay,
        .singular-overlay {
            pointer-events: auto !important;
        }
    `, 'yte-overlay-base');

        log("Added global overlay styles");

        // Run once up front. onMutationsFinished is debounced, so leaving the first
        // pass to it means waiting for the whole page to stop mutating before the
        // blur rules are even installed.
        lastUrl = location.href;
        MAIN();

        const observer = new MutationObserver(onMutationsFinished);
        observer.observe(document, {subtree: true, childList: true});
    }

    return initializeOverlays
})();
