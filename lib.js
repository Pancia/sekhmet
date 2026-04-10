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
}

function saveFile(filename, data) {
    const file = new Blob([data], {type: "text/plain"});
    const a = document.createElement("a");
    const url = URL.createObjectURL(file);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }, 0);
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
                clearInterval(timer);
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

                    timer = setInterval(function() {
                        const now = Date.now();
                        elapsed += now - startTime;
                        startTime = now;
                        const progress = ((elapsed / _this.settings.holdTime) * 100 - 100) + "%";
                        _this.element.querySelector(".holdButtonProgress").style.left = progress;

                        if (elapsed >= _this.settings.holdTime) {
                            isActive = false;
                            resetAccumulated();
                            _this.exitTimer(timer);

                            // Trigger complete event
                            const completeEvent = new CustomEvent('complete.pressAndHold');
                            _this.element.dispatchEvent(completeEvent);
                        }
                    }, 10);

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
            clearInterval(timer);

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
