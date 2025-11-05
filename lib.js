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

var __iter = 0;
function waitForElementToBeLoaded(selector, callback, elementTest) {
    function out(elem) {
        if ((__iter++ % 5) == 0) {
            console.debug("[lib/wait]:", selector, elem, (elementTest && elementTest(elem) || "nil"))
        }
    }
    const tid = setInterval(function() {
        const x = document.querySelector(selector);
        // wait for x element to have been loaded, ie: not null & has width
        if (x == null || x.offsetWidth <= 0 || x.offsetHeight <= 0) { out(x); return }
        if (elementTest && !elementTest(x)) { out(x); return }
        // x was loaded, go ahead!
        clearInterval(tid);
        callback(x);
    }, 100);
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
        this.init();
    }

    Plugin.prototype = {
        init: function() {
            const _this = this;
            let timer;
            let decaCounter;
            let isActive = false;
            let progressIndicatorHTML;

            // Setup the element styling
            this.element.style.display = 'block';
            this.element.style.overflow = 'hidden';
            this.element.style.position = 'relative';

            // Create progress indicator
            progressIndicatorHTML = `<div class="holdButtonProgress" style="height: 100%; width: 100%; position: absolute; top: 0; left: -100%; background-color:${this.settings.progressIndicatorColor}; opacity:${this.settings.progressIndicatorOpacity};"></div>`;
            this.element.insertAdjacentHTML('afterbegin', progressIndicatorHTML);

            // Add mousedown event
            this.element.addEventListener('mousedown', function(e) {
                if (e.button == 2) { return; }
                if (isActive) {
                    if (_this.settings.isClickDisabled !== true) {
                        decaCounter += 100;
                    }
                } else {
                    // Trigger start event
                    const startEvent = new CustomEvent('start.pressAndHold');
                    _this.element.dispatchEvent(startEvent);

                    isActive = true;
                    decaCounter = 0;

                    timer = setInterval(function() {
                        decaCounter += 10;
                        const progress = ((decaCounter / _this.settings.holdTime) * 100 - 100) + "%";
                        _this.element.querySelector(".holdButtonProgress").style.left = progress;

                        if (decaCounter >= _this.settings.holdTime) {
                            isActive = false;
                            _this.exitTimer(timer);

                            // Trigger complete event
                            const completeEvent = new CustomEvent('complete.pressAndHold');
                            _this.element.dispatchEvent(completeEvent);
                        }
                    }, 10);

                    // Add mouseleave listener
                    _this.element.addEventListener('mouseleave', function handler(event) {
                        isActive = false;
                        _this.exitTimer(timer);
                        _this.element.removeEventListener('mouseleave', handler);
                    });
                }
            });
        },

        exitTimer: function(timer) {
            const _this = this;
            clearTimeout(timer);

            setTimeout(function() {
                const progressElements = document.querySelectorAll(".holdButtonProgress");
                for (let i = 0; i < progressElements.length; i++) {
                    progressElements[i].style.left = "-100%";
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
