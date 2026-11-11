function initLogger(module) {
    const prefix = `[YT+] [${module}]:`
    function log(...args) {
        console.log(prefix, ...args)
    }
    function debug(...args) {
        console.debug(prefix, ...args)
    }
    function error(...args) {
        console.error(prefix, ...args)
    }
    return { log, debug, error }
}

function waitForElementToBeLoaded(selector, callback, elementTest, config) {
    // Default configuration
    const defaultConfig = {
        initialWait: 100,      // Starting wait time in ms
        increaseAfter: 10,     // Iterations before starting to increase
        increaseBy: 1.5,       // Multiplier
        maxWait: 5000          // Maximum wait time in ms
    };

    const cfg = Object.assign({}, defaultConfig, config || {});

    let iteration = 0;
    let currentWait = cfg.initialWait;
    let timeoutId;

    function checkElement() {
        iteration++;

        // wait for x element to have been loaded, ie: not null & has width
        const x = document.querySelector(selector);
        if (x == null || x.offsetWidth <= 0 || x.offsetHeight <= 0) {
            scheduleNextCheck();
            return;
        }

        // Optional validation function (e.g., check for children)
        if (elementTest && !elementTest(x)) {
            console.debug(`[lib/wait] Element ${selector} found but validation failed, waiting...`);
            scheduleNextCheck();
            return;
        }

        // x was loaded and validated, go ahead!
        console.debug(`[lib/wait] Element ${selector} loaded and validated after ${iteration} iterations`);
        callback(x);
    }

    function scheduleNextCheck() {
        // Update wait time if we've passed the threshold
        if (iteration >= cfg.increaseAfter) {
            const oldWait = currentWait;

            // Calculate new wait time
            if (typeof cfg.increaseBy === 'function') {
                currentWait = cfg.increaseBy(iteration, currentWait);
            } else {
                // Assume it's a multiplier
                currentWait = currentWait * cfg.increaseBy;
            }

            // Cap at maxWait
            currentWait = Math.min(currentWait, cfg.maxWait);

            // Log if wait time changed
            if (oldWait !== currentWait) {
                console.debug(`[lib/wait] Increasing wait time from ${oldWait}ms to ${currentWait}ms (iteration ${iteration})`);
            }
        }

        // Schedule next check
        timeoutId = setTimeout(checkElement, currentWait);
    }

    // Start the first check
    timeoutId = setTimeout(checkElement, currentWait);

    // There is no iteration cap, so a selector that never validates polls for the life
    // of the tab. On an SPA that is per navigation, not per page load - callers need a
    // way to stop the ones belonging to a page they have navigated away from.
    return function cancelWait() {
        clearTimeout(timeoutId);
        timeoutId = null;
    };
}

// The pill the masthead buttons share - the 🧭 feeling tracker and the 📽️
// downloader. They are built by different modules at different times, so
// whichever gets there first makes it and the other joins. Each places itself
// (the compass prepends, the projector appends) so the order does not depend
// on which one won. YouTube's own chip colours, so it follows light and dark.
function mastheadPill() {
    const existing = document.getElementById("sekhmet-masthead-pill");
    if (existing) { return existing; }

    const center = document.querySelector("#center.ytd-masthead");
    if (!center) { return null; }

    const pill = document.createElement("div");
    pill.id = "sekhmet-masthead-pill";
    pill.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 10px;
        flex-shrink: 0;
        height: 44px;
        padding: 0 14px;
        margin-right: 12px;
        box-sizing: border-box;
        border-radius: 9999px;
        background: var(--yt-spec-badge-chip-background, rgba(128, 128, 128, 0.15));
        border: 1px solid var(--yt-spec-10-percent-layer, rgba(128, 128, 128, 0.25));
    `;
    center.prepend(pill);
    return pill;
}

// Focus can sit inside a shadow root, in which case document.activeElement
// reports the host rather than the focused node. Walk down to the real one.
function deepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
        el = el.shadowRoot.activeElement;
    }
    return el;
}

// Is this key event aimed at somewhere the user is typing? Any module claiming a
// global hotkey has to bail out here, or it eats keystrokes meant for the search
// box or a comment. Checks the event's own target as well as the focused element,
// because the two disagree often enough to matter.
function isTypingTarget(event) {
    const path = event && event.composedPath ? event.composedPath() : null;
    const candidates = [path && path[0], deepActiveElement()];
    for (const el of candidates) {
        if (!el || el.nodeType !== 1) continue;
        const tag = el.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        // The property rather than the attribute: YouTube's comment box is a
        // nested #contenteditable-root, so the flag has to resolve by inheritance.
        if (el.isContentEditable) return true;
    }
    return false;
}

// Lightweight in-page toasts. Content scripts share the page's DOM, so
// everything is inline-styled under one container (plus a single injected
// keyframes rule) to avoid collisions with YouTube's own stylesheets.
//
//   const t = showToast("Sending…", { status: "pending", timeout: 0 });
//   t.update("Started", { status: "ok" });   // resets the auto-dismiss timer
//   t.dismiss();
function showToast(message, options) {
    const CONTAINER_ID = "sekhmet-toast-container";
    const STYLE_ID = "sekhmet-toast-style";
    const MAX_VISIBLE = 5;
    const STATUSES = {
        pending: { accent: "#3ea6ff", icon: null },   // null => spinner
        ok:      { accent: "#2ba640", icon: "✅" },
        error:   { accent: "#f44336", icon: "⚠️" },
        info:    { accent: "#909090", icon: "ℹ️" }
    };

    const opts = Object.assign({ status: "info", timeout: 4000 }, options || {});

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = "@keyframes sekhmet-toast-spin { to { transform: rotate(360deg); } }";
        (document.head || document.documentElement).appendChild(style);
    }

    function ensureContainer() {
        let container = document.getElementById(CONTAINER_ID);
        if (container) return container;
        container = document.createElement("div");
        container.id = CONTAINER_ID;
        Object.assign(container.style, {
            position: "fixed",
            // Below YouTube's 56px masthead so toasts don't cover the avatar
            // / search bar.
            top: "72px",
            right: "20px",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "8px",
            // Above the ytdl dialog backdrop (9999) and YouTube's own overlays.
            zIndex: "2147483000",
            pointerEvents: "none"
        });
        document.body.appendChild(container);
        return container;
    }

    ensureStyle();
    const container = ensureContainer();

    const toast = document.createElement("div");
    Object.assign(toast.style, {
        display: "flex",
        alignItems: "flex-start",
        gap: "10px",
        boxSizing: "border-box",
        minWidth: "220px",
        maxWidth: "340px",
        padding: "10px 14px",
        borderRadius: "8px",
        borderLeft: "4px solid transparent",
        backgroundColor: "rgba(28, 28, 28, 0.96)",
        color: "#fff",
        fontFamily: "Roboto, Arial, sans-serif",
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.45)",
        cursor: "pointer",
        pointerEvents: "auto",
        opacity: "0",
        transform: "translateY(-8px)",
        transition: "opacity 0.18s ease, transform 0.18s ease"
    });

    const iconSlot = document.createElement("span");
    Object.assign(iconSlot.style, {
        flex: "0 0 auto",
        width: "16px",
        height: "16px",
        marginTop: "1px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "14px",
        lineHeight: "16px"
    });

    const body = document.createElement("div");
    body.style.flex = "1";
    body.style.minWidth = "0";

    const title = document.createElement("div");
    Object.assign(title.style, {
        fontSize: "13px",
        fontWeight: "500",
        lineHeight: "1.35",
        wordBreak: "break-word"
    });

    const detail = document.createElement("div");
    Object.assign(detail.style, {
        display: "none",
        marginTop: "3px",
        fontSize: "11px",
        lineHeight: "1.35",
        opacity: "0.7",
        wordBreak: "break-word"
    });

    body.appendChild(title);
    body.appendChild(detail);
    toast.appendChild(iconSlot);
    toast.appendChild(body);

    let dismissTimer;
    let removed = false;
    let hovered = false;
    let pendingTimeout = 0;

    function renderStatus(status, iconOverride) {
        const spec = STATUSES[status] || STATUSES.info;
        toast.style.borderLeftColor = spec.accent;
        iconSlot.textContent = "";
        const icon = iconOverride || spec.icon;
        if (icon) {
            iconSlot.textContent = icon;
            return;
        }
        // Pending: spinner instead of a glyph.
        const spinner = document.createElement("span");
        Object.assign(spinner.style, {
            width: "12px",
            height: "12px",
            borderRadius: "50%",
            border: "2px solid rgba(255, 255, 255, 0.25)",
            borderTopColor: spec.accent,
            animation: "sekhmet-toast-spin 0.7s linear infinite"
        });
        iconSlot.appendChild(spinner);
    }

    function scheduleDismiss(timeout) {
        clearTimeout(dismissTimer);
        pendingTimeout = timeout;
        if (!timeout || hovered) return;
        dismissTimer = setTimeout(dismiss, timeout);
    }

    function render(text, o) {
        title.textContent = text;
        if (o.detail) {
            detail.textContent = o.detail;
            detail.style.display = "block";
        } else {
            detail.style.display = "none";
        }
        renderStatus(o.status, o.icon);
        scheduleDismiss(o.timeout);
    }

    function dismiss() {
        if (removed) return;
        removed = true;
        clearTimeout(dismissTimer);
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-8px)";
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
            if (container.children.length === 0 && container.parentNode) {
                container.parentNode.removeChild(container);
            }
        }, 200);
    }

    function update(text, o) {
        if (removed) return handle;
        render(text, Object.assign({ status: "info", timeout: 4000 }, o || {}));
        return handle;
    }

    // Hovering holds the toast open (so long error text stays readable).
    toast.addEventListener("mouseenter", () => {
        hovered = true;
        clearTimeout(dismissTimer);
    });
    toast.addEventListener("mouseleave", () => {
        hovered = false;
        scheduleDismiss(pendingTimeout);
    });
    toast.addEventListener("click", dismiss);

    render(message, opts);
    container.appendChild(toast);

    // Drop the oldest toasts if they pile up.
    while (container.children.length > MAX_VISIBLE) {
        container.removeChild(container.firstChild);
    }

    requestAnimationFrame(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateY(0)";
    });

    const handle = { element: toast, update, dismiss };
    return handle;
}

function initPressAndHoldPlugin() {
    const pressAndHold = "pressAndHold";
    const defaults = {
        holdTime: 700,
        progressIndicatorRemoveDelay: 300,
        progressIndicatorColor: "#ff0000",
        progressIndicatorOpacity: 0.6
    };

    function Plugin(element, options) {
        this.element = element;
        this.settings = Object.assign({}, defaults, options);
        this._defaults = defaults;
        this._name = pressAndHold;
        this._accumulated = 0;
        this.init();
    }

    Plugin.prototype = {
        init: function() {
            const _this = this;
            let timer;
            let elapsed;
            let startTime;
            let isActive = false;
            let progressIndicatorHTML;

            // Setup the element styling
            this.element.style.display = 'block';
            this.element.style.overflow = 'hidden';
            this.element.style.position = 'relative';

            // Wrap existing content so it stays above the progress bar
            const contentWrapper = document.createElement('span');
            contentWrapper.style.position = 'relative';
            contentWrapper.style.zIndex = '1';
            while (this.element.firstChild) {
                contentWrapper.appendChild(this.element.firstChild);
            }
            this.element.appendChild(contentWrapper);

            // Create progress indicator
            progressIndicatorHTML = `<div class="holdButtonProgress" style="height: 100%; width: 100%; position: absolute; top: 0; left: -100%; z-index: 0; background-color:${this.settings.progressIndicatorColor}; opacity:${this.settings.progressIndicatorOpacity};"></div>`;
            this.element.insertAdjacentHTML('afterbegin', progressIndicatorHTML);

            function readAccumulated() {
                const mem = _this.settings.progressMemory;
                if (mem && typeof mem === 'object') {
                    return mem.accumulated;
                } else if (mem === "instance") {
                    return _this._accumulated;
                }
                return 0;
            }

            function saveAccumulated(value) {
                const mem = _this.settings.progressMemory;
                if (mem && typeof mem === 'object') {
                    mem.accumulated = value;
                } else if (mem === "instance") {
                    _this._accumulated = value;
                }
            }

            function resetAccumulated() {
                const mem = _this.settings.progressMemory;
                if (mem && typeof mem === 'object') {
                    mem.accumulated = 0;
                } else if (mem === "instance") {
                    _this._accumulated = 0;
                }
            }

            function pause() {
                if (!isActive) return;
                isActive = false;
                cancelAnimationFrame(timer);
                elapsed += Date.now() - startTime;

                if (_this.settings.progressMemory) {
                    // Save progress, leave bar in place
                    saveAccumulated(elapsed);
                } else {
                    _this.exitTimer(timer);
                }
            }

            // Add mousedown event
            this.element.addEventListener('mousedown', function(e) {
                if (e.button == 2) { return; }
                if (isActive) {
                    if (_this.settings.isClickDisabled !== true) {
                        elapsed += 100;
                    }
                } else {
                    isActive = true;
                    elapsed = readAccumulated();
                    startTime = Date.now();

                    // Only fire start event on fresh start, not resume
                    if (elapsed === 0) {
                        const startEvent = new CustomEvent('start.pressAndHold');
                        _this.element.dispatchEvent(startEvent);
                    }

                    // Set progress bar to current accumulated position immediately
                    const initialProgress = ((elapsed / _this.settings.holdTime) * 100 - 100) + "%";
                    _this.element.querySelector(".holdButtonProgress").style.left = initialProgress;

                    const bar = _this.element.querySelector(".holdButtonProgress");
                    function tick() {
                        if (!isActive) return;
                        const now = Date.now();
                        const current = elapsed + (now - startTime);
                        const pct = Math.min(current / _this.settings.holdTime, 1);
                        bar.style.left = (pct * 100 - 100) + "%";

                        if (current >= _this.settings.holdTime) {
                            isActive = false;
                            elapsed = _this.settings.holdTime;
                            resetAccumulated();
                            _this.exitTimer(timer);

                            const completeEvent = new CustomEvent('complete.pressAndHold');
                            _this.element.dispatchEvent(completeEvent);
                            return;
                        }
                        timer = requestAnimationFrame(tick);
                    }
                    timer = requestAnimationFrame(tick);

                    // Add self-removing mouseleave listener
                    _this.element.addEventListener('mouseleave', function leaveHandler(event) {
                        pause();
                        _this.element.removeEventListener('mouseleave', leaveHandler);
                    });
                }
            });
        },

        exitTimer: function(timer) {
            const _this = this;
            cancelAnimationFrame(timer);

            setTimeout(function() {
                const progressEl = _this.element.querySelector(".holdButtonProgress");
                if (progressEl) {
                    progressEl.style.left = "-100%";
                }
                const endEvent = new CustomEvent('end.pressAndHold');
                _this.element.dispatchEvent(endEvent);
            }, this.settings.progressIndicatorRemoveDelay);
        }
    };

    Element.prototype.pressAndHold = function(options) {
        new Plugin(this, options);
        return this;
    };
}
initPressAndHoldPlugin();

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
