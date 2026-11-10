// Browser stubs for running the content-script modules under node.
//
// These modules are plain scripts sharing one global scope in the browser rather
// than CommonJS, so a test installs the globals they expect from polyfill.js and
// lib.js, then calls loadModule() to evaluate the file under test.
//
// The stubs are deliberately thin. They model the handful of behaviours the
// modules actually depend on - that media events do not bubble, that YouTube
// reuses one <video> across navigation, that storage can fail - and nothing else.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const store = {};
let readFails = false;
let writeFails = false;
const onChangedCbs = [];

exports.store = store;
exports.failReads = v => { readFails = v; };
exports.failWrites = v => { writeFails = v; };

// Extension reloaded with the page still open: the content script keeps running
// but browser.runtime.id is gone and storage is unreachable.
exports.contextLost = v => { global.browser.runtime.id = v ? undefined : 'test'; };

global.browser = {
    runtime: { id: 'test' },
    storage: {
        local: {
            get: k => readFails
                ? Promise.reject(new Error('transient storage failure'))
                : Promise.resolve(k in store ? { [k]: store[k] } : {}),
            set: d => writeFails
                ? Promise.reject(new Error('quota exceeded'))
                : (Object.assign(store, d), Promise.resolve()),
            remove: k => { delete store[k]; return Promise.resolve(); }
        },
        onChanged: { addListener: cb => onChangedCbs.push(cb) }
    }
};

// What the browser delivers after another tab writes. Pass undefined to model
// storage.local.remove(), which is the documented wholesale escape hatch.
exports.otherTabWrote = (key, newValue) => {
    if (newValue === undefined) { delete store[key]; } else { store[key] = newValue; }
    onChangedCbs.forEach(cb => cb({ [key]: { newValue } }, 'local'));
};

class HTMLVideoElement {
    constructor(tag) {
        this.loop = false;
        this.tag = tag;
        this.paused = false;
        this.currentTime = 0;
        this.duration = 600;
        this.playbackRate = 1;
        this.adShowing = false;
    }
    // Only ever asked for the player root, and only to read its ad-showing class.
    closest() {
        return { classList: { contains: c => c === 'ad-showing' && this.adShowing } };
    }
}
global.HTMLVideoElement = HTMLVideoElement;
exports.newVideo = tag => new HTMLVideoElement(tag);

// selector -> element, so the exact selector a module reaches for is testable.
// That is what catches a fallback quietly matching the hover-preview player.
let dom = {};
exports.setDom = d => { dom = d; };

const docListeners = {};
global.document = {
    querySelector: sel => (sel in dom ? dom[sel] : null),
    getElementById: () => null,
    addEventListener: (t, cb) => { (docListeners[t] = docListeners[t] || []).push(cb); }
};

// Media events do not bubble, but a capturing listener on document still sees
// them on the way down to the target. Replay that.
exports.dispatch = (type, target) => {
    (docListeners[type] || []).forEach(cb => cb({ target }));
};

const observers = [];
global.MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() { observers.push(this.cb); }
};
// One DOM mutation, which is how a module learns about SPA navigation.
exports.mutate = () => observers.forEach(cb => cb());

let keyHandler = null;
global.window = {
    location: null,
    addEventListener: (t, cb) => { if (t === 'keydown') keyHandler = cb; }
};

exports.key = opts => {
    let prevented = false;
    keyHandler(Object.assign({
        key: 'L', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false,
        repeat: false, isComposing: false, keyCode: 76,
        preventDefault: () => { prevented = true; },
        stopImmediatePropagation: () => {}
    }, opts || {}));
    return prevented;
};

exports.nav = href => {
    const u = new URL(href);
    global.window.location = {
        hostname: u.hostname, pathname: u.pathname, search: u.search, href
    };
};

// lib.js's poller, reduced to something a test can drive by hand.
let pendingWait = null;
exports.playerWaitPending = () => !!pendingWait;
exports.playerArrives = () => { const w = pendingWait; pendingWait = null; if (w) w(); };
global.waitForElementToBeLoaded = (selector, cb) => {
    pendingWait = cb;
    return function cancel() { if (pendingWait === cb) pendingWait = null; };
};

const toasts = [];
exports.toasts = toasts;
exports.lastToast = () => toasts[toasts.length - 1] || null;
global.showToast = (msg, opts) => {
    const rec = { text: msg, status: (opts || {}).status, detail: null, updates: 0 };
    toasts.push(rec);
    const handle = {
        element: null,
        update: (text, o) => {
            rec.text = text;
            rec.status = (o || {}).status;
            rec.detail = (o || {}).detail || null;
            rec.updates++;
            return handle;
        },
        dismiss: () => {}
    };
    return handle;
};

global.isTypingTarget = () => false;
global.initLogger = () => ({ log() {}, debug() {}, error() {} });

// The modules declare their global with `let`, which an eval would scope to the
// eval itself. Rewriting the one declaration is what makes the module reachable
// afterwards - and re-evaluating is how a test models a fresh page load.
exports.loadModule = (file, globalName) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
        .replace(new RegExp('^let ' + globalName + ' = '), 'globalThis.' + globalName + ' = ');
    (0, eval)(src);
};

// Per-page-load state that must not leak between test groups.
exports.reset = () => {
    Object.keys(store).forEach(k => delete store[k]);
    pendingWait = null;
    observers.length = 0;
    onChangedCbs.length = 0;
    Object.keys(docListeners).forEach(type => delete docListeners[type]);
    readFails = false;
    writeFails = false;
    global.browser.runtime.id = 'test';
};

exports.tick = () => new Promise(r => setImmediate(r));
