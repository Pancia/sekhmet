// The feeling check-in countdown ring, on a fake watch page. The real lib.js,
// loop.js and feeling-tracker.js are injected into the page with a stubbed
// browser.storage, and Date.now runs at an adjustable rate so the 7.5-minute
// interval and the 60-second opening grace can be crossed in seconds. The
// scripts run in the page's main world, not a content script's isolated world.
const fs = require('fs');
const path = require('path');
const { ROOT, sleep, check, shot, withBrowser, run } = require('./common');

const html = `<!doctype html><html><body style="margin:0;background:#111">
<div id="center" class="ytd-masthead" style="height:56px;display:flex"></div><button id="avatar-btn">a</button>
<div id="movie_player" class="html5-video-player" style="position:relative;width:640px"><video class="html5-main-video" muted playsinline style="width:100%;display:block"></video></div></body></html>`;

const ID = '#sekhmet-ft-countdown';
const INTERVAL = 7.5 * 60 * 1000; // CHECK_INTERVAL_MINUTES in feeling-tracker.js
const clip = fs.readFileSync(path.join(__dirname, 'long.mp4'));
const pageErrors = [];

// A fresh watch page whose tracker has msLeft of playing time to go before the
// check-in, with the video playing from `position` seconds.
async function boot(b, msLeft, position) {
    const p = await b.newPage();
    await p.setViewport({ width: 1100, height: 700 });
    p.on('pageerror', e => pageErrors.push(e.message));
    await p.setRequestInterception(true);
    p.on('request', r => {
        const u = r.url();
        if (u.includes('/watch')) return r.respond({ status: 200, contentType: 'text/html', body: html });
        if (u.endsWith('/v.mp4')) return r.respond({ status: 200, contentType: 'video/mp4', body: clip });
        r.abort();
    });
    await p.evaluateOnNewDocument(accumulated => {
        const realNow = Date.now.bind(Date);
        let rate = 1, base = realNow(), virtual = base;
        const now = () => virtual + (realNow() - base) * rate;
        Date.now = now;
        window.__setRate = r => { virtual = now(); base = realNow(); rate = r; };

        const s = { sekhmet_accumulatedPlayTime: accumulated, sekhmet_lastActiveTime: realNow() };
        window.__s = s;
        const copy = o => JSON.parse(JSON.stringify(o));
        window.browser = {
            runtime: { id: 'x', sendMessage: () => Promise.resolve({ tabId: 1 }), onMessage: { addListener() {} } },
            storage: {
                local: {
                    get: k => {
                        const o = {};
                        if (typeof k === 'string') { if (k in s) o[k] = s[k]; }
                        else if (Array.isArray(k)) { k.forEach(x => { if (x in s) o[x] = s[x]; }); }
                        else if (k && typeof k === 'object') { for (const x in k) o[x] = x in s ? s[x] : k[x]; }
                        else Object.assign(o, s);
                        return Promise.resolve(copy(o));
                    },
                    set: d => { Object.assign(s, copy(d)); return Promise.resolve(); }
                },
                onChanged: { addListener() {} }
            }
        };
    }, INTERVAL - msLeft);

    await p.goto('https://www.youtube.com/watch?v=AAA');
    for (const f of ['lib.js', 'loop.js', 'feeling-tracker.js']) {
        await p.addScriptTag({ content: fs.readFileSync(path.join(ROOT, f), 'utf8') });
    }
    await p.evaluate(async pos => {
        const v = document.querySelector('video');
        const blob = await (await fetch('/v.mp4')).blob();
        v.src = URL.createObjectURL(blob);
        await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
        v.currentTime = pos;
        await v.play();
        window.__playerClicks = 0;
        document.getElementById('movie_player').addEventListener('click', () => window.__playerClicks++);
        YTELoop.init();
        initializeFeelingTracker();
    }, position);
    return p;
}

// The ring's seconds as a number, or null while it is hidden.
const secs = p => p.$eval(ID, e => e.querySelector('.seconds').textContent).then(Number).catch(() => null);
const hasDialog = p => p.evaluate(() => !!document.getElementById('feeling-dialog'));
const paused = p => p.evaluate(() => document.querySelector('video').paused);
const waitFor = async (fn, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await fn()) return true;
        await sleep(100);
    }
    return false;
};
// Fast-forward until the ring shows, then back to real time.
const untilRing = async p => {
    await p.evaluate(() => __setRate(15));
    const shown = await waitFor(async () => (await secs(p)) !== null, 12000);
    await p.evaluate(() => __setRate(1));
    return shown;
};

run(() => withBrowser(async b => {
    console.log('--- runs to zero');
    let p = await boot(b, 100000, 70);
    await sleep(2200);
    check('100s before the check-in there is no ring', (await secs(p)) === null, await secs(p));
    check('the ring appears inside the last 30s', await untilRing(p) && (await secs(p)) <= 30, await secs(p));
    const parent = await p.$eval(ID, e => e.parentElement.id);
    check('the ring sits in the player', parent === 'movie_player', parent);
    await sleep(1000);
    const rest = await p.$eval(ID, e => ({ opacity: getComputedStyle(e).opacity, near: e.classList.contains('near') }));
    check('at rest it is dimmed and not "near"', rest.opacity === '0.8' && !rest.near, rest);
    await shot(p, 'countdown-rest.png');

    const a = await secs(p);
    await sleep(3000);
    const c = await secs(p);
    check('it counts down while playing', c < a, `${a} -> ${c}`);

    await p.evaluate(() => document.querySelector('video').pause());
    await sleep(1500);
    const d = await secs(p);
    await sleep(3000);
    const e = await secs(p);
    check('it freezes while paused', d === e, `${d} -> ${e}`);
    await p.evaluate(() => document.querySelector('video').play());
    await sleep(2500);
    const resumed = await secs(p);
    check('it resumes on play', resumed < e, `${e} -> ${resumed}`);

    await p.evaluate(() => __setRate(5));
    const near = await waitFor(() => p.$eval(ID, el => el.classList.contains('near')).catch(() => false), 12000);
    const nearAt = await secs(p);
    await p.evaluate(() => __setRate(1));
    check('it turns "near" in the last 10s', near && nearAt <= 10, nearAt);
    await sleep(600);
    const nearOpacity = await p.$eval(ID, el => getComputedStyle(el).opacity);
    check('near is full brightness', nearOpacity === '1', nearOpacity);

    const fired = await waitFor(() => hasDialog(p), 14000);
    check('the check-in opens at zero, pausing the video and hiding the ring',
        fired && (await secs(p)) === null && await paused(p), { fired, ring: await secs(p), paused: await paused(p) });
    await p.close();

    console.log('--- click early, and tracker turned off');
    p = await boot(b, 100000, 70);
    await p.waitForSelector('#sekhmet-ft-status', { timeout: 8000 });
    check('the ring appears', await untilRing(p));

    await p.evaluate(() => document.querySelector('video').pause());
    await sleep(300);
    const menuBtn = async text => {
        const h = await p.evaluateHandle(t =>
            [...document.querySelectorAll('#sekhmet-ft-status-menu-backdrop button')].find(x => x.textContent.includes(t)), text);
        await h.click();
        await sleep(200);
    };
    await p.click('#sekhmet-ft-status');
    await sleep(200);
    await menuBtn('Disable Tracker');
    await sleep(1500);
    check('turning the tracker off while paused hides the ring', (await secs(p)) === null, await secs(p));
    await p.click('#sekhmet-ft-status');
    await sleep(200);
    await menuBtn('Enable Tracker');
    await p.evaluate(() => document.querySelector('video').play());
    check('turning it back on brings the ring back', await waitFor(async () => (await secs(p)) !== null, 4000));

    await p.hover(ID);
    await sleep(600);
    const hover = await p.$eval(ID, el => ({ hint: el.querySelector('.hint').getBoundingClientRect().width, opacity: getComputedStyle(el).opacity }));
    check('hovering shows the "Check in now" label at full brightness', hover.hint > 20 && hover.opacity === '1', hover);
    await shot(p, 'countdown-hover.png');

    const before = await p.evaluate(() => __s.sekhmet_accumulatedPlayTime);
    await p.click(ID);
    await sleep(300);
    await shot(p, 'countdown-dialog.png');
    const clicked = {
        dialog: await hasDialog(p), ring: await secs(p), paused: await paused(p),
        playerClicks: await p.evaluate(() => __playerClicks),
        kept: (await p.evaluate(() => __s.sekhmet_accumulatedPlayTime)) >= before
    };
    check('a click opens the check-in early', clicked.dialog && clicked.ring === null && clicked.paused, clicked);
    check('the click does not reach the player (no play/pause toggle)', clicked.playerClicks === 0, clicked);
    check('opening early keeps the accumulated time', clicked.kept, clicked);
    await p.close();

    console.log('--- a new video opening holds it back');
    p = await boot(b, 10000, 5);
    await sleep(3000);
    check('10s to the mark at 0:05 into a new video: no ring, no check-in',
        (await secs(p)) === null && !(await hasDialog(p)), { ring: await secs(p), dialog: await hasDialog(p) });
    await p.evaluate(() => { document.querySelector('video').currentTime = 40; __setRate(20); });
    await sleep(3400);
    await p.evaluate(() => __setRate(1));
    await sleep(1200);
    const held = { position: await p.evaluate(() => Math.round(document.querySelector('video').currentTime)), ring: await secs(p), dialog: await hasDialog(p) };
    check('once the watched minute is up, the ring counts down the rest of the opening', held.ring !== null && !held.dialog, held);
    const opened = await waitFor(() => hasDialog(p), 22000);
    const pos = await p.evaluate(() => Math.round(document.querySelector('video').currentTime));
    check('the check-in opens when the opening ends (position 1:00)', opened && pos >= 59 && pos <= 63, { opened, pos });
    await p.close();

    console.log('--- feed and back (miniplayer)');
    p = await boot(b, 100000, 70);
    await p.waitForSelector('#sekhmet-ft-status', { timeout: 8000 });
    check('the ring appears', await untilRing(p));
    const nav = u => p.evaluate(x => history.pushState({}, '', x), u);
    const leaving = await secs(p);
    await nav('/');
    await sleep(1500);
    check('on the feed the ring is hidden', (await secs(p)) === null, await secs(p));
    await sleep(1500);
    await nav('/watch?v=AAA');
    const back = await waitFor(async () => (await secs(p)) !== null, 3000);
    const backAt = await secs(p);
    // A restarted 60s grace would keep the ring hidden; a kept one shows it
    // again near where it was (the feed does not count as playing time).
    check('back on the same video the ring returns at once', back, backAt);
    check('it carries on from where it was, not from a fresh opening hold',
        backAt !== null && backAt <= leaving && leaving - backAt <= 4, `${leaving} -> ${backAt}`);
    await sleep(2000);
    const still = await secs(p);
    check('it keeps counting', still !== null && still < backAt, `${backAt} -> ${still}`);
    await nav('/watch?v=BBB');
    await sleep(1500);
    check('a different video restarts the opening hold (ring hidden)', (await secs(p)) === null, await secs(p));
    await p.close();

    console.log('--- fullscreen');
    p = await boot(b, 100000, 70);
    await p.waitForSelector('#sekhmet-ft-status', { timeout: 8000 });
    await untilRing(p);
    await p.evaluate(() => document.getElementById('movie_player').requestFullscreen());
    await sleep(600);
    const fs1 = { full: await p.evaluate(() => document.fullscreenElement && document.fullscreenElement.id), ring: await secs(p) };
    check('the ring shows in fullscreen', fs1.full === 'movie_player' && fs1.ring !== null, fs1);
    await p.click(ID);
    await sleep(300);
    const where = () => p.evaluate(() => {
        const dlg = document.getElementById('feeling-dialog');
        const r = dlg.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
        return { parent: dlg.parentElement.id || dlg.parentElement.tagName, onTop: dlg.contains(hit) };
    });
    let w = await where();
    check('the check-in opens inside the fullscreen player, on top', w.parent === 'movie_player' && w.onTop && await paused(p), w);
    await shot(p, 'countdown-fullscreen.png');
    await p.evaluate(() => document.exitFullscreen());
    await sleep(500);
    w = await where();
    check('leaving fullscreen moves it back to the page', w.parent === 'BODY' && w.onTop, w);
    await p.evaluate(() => document.getElementById('movie_player').requestFullscreen());
    await sleep(500);
    w = await where();
    check('entering fullscreen with it open moves it in again', w.parent === 'movie_player' && w.onTop, w);
    await p.close();

    console.log('--- too short to clear the opening');
    p = await boot(b, 20000, 40);
    await p.evaluate(() => {
        Object.defineProperty(document.querySelector('video'), 'duration', { value: 45, configurable: true });
        __setRate(20);
    });
    await sleep(3400);
    await p.evaluate(() => __setRate(1));
    await sleep(1200);
    check('a 45s video never shows the ring or the check-in',
        (await secs(p)) === null && !(await hasDialog(p)), { ring: await secs(p), dialog: await hasDialog(p) });
    await p.close();

    check('no page errors', pageErrors.length === 0, pageErrors);
}));
