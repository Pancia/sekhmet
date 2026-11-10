// Loop range: the compass-menu controls and the timeline bar, on a fake watch
// page. The real lib.js, loop.js and feeling-tracker.js are injected into the
// page with a stubbed browser.storage. They run in the page's main world, not
// the isolated world a real content script gets.
const fs = require('fs');
const path = require('path');
const { ROOT, sleep, check, shot, withBrowser, run } = require('./common');

const html = `<!doctype html><html><body style="margin:0;background:#111">
<div id="center" class="ytd-masthead" style="height:56px;display:flex"></div><button id="avatar-btn">a</button>
<div id="movie_player" class="html5-video-player" style="width:640px"><video class="html5-main-video" muted playsinline></video></div></body></html>`;

const MENU = '#sekhmet-ft-status-menu-backdrop';
const clip = fs.readFileSync(path.join(__dirname, 'v.mp4'));

run(() => withBrowser(async b => {
    const p = await b.newPage();
    await p.setViewport({ width: 1100, height: 1000 });
    const pageErrors = [];
    p.on('pageerror', e => pageErrors.push(e.message));
    await p.setRequestInterception(true);
    p.on('request', r => {
        const u = r.url();
        if (u.includes('/watch')) return r.respond({ status: 200, contentType: 'text/html', body: html });
        if (u.endsWith('/v.mp4')) return r.respond({ status: 200, contentType: 'video/mp4', body: clip });
        r.abort();
    });
    await p.evaluateOnNewDocument(() => {
        const s = {};
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
    });

    await p.goto('https://www.youtube.com/watch?v=AAA');
    for (const f of ['lib.js', 'loop.js', 'feeling-tracker.js']) {
        await p.addScriptTag({ content: fs.readFileSync(path.join(ROOT, f), 'utf8') });
    }
    await p.evaluate(async () => {
        const v = document.querySelector('video');
        const blob = await (await fetch('/v.mp4')).blob();
        v.src = URL.createObjectURL(blob);
        await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
        await v.play();
        YTELoop.init();
        initializeFeelingTracker();
    });

    await p.waitForSelector('#sekhmet-ft-status', { timeout: 8000 });
    await sleep(300);
    await p.click('#sekhmet-ft-status');
    await sleep(200);

    const clickBtn = async text => {
        const h = await p.evaluateHandle((m, t) =>
            [...document.querySelectorAll(m + ' button')].find(x => x.textContent.includes(t)), MENU, text);
        await h.click();
        await sleep(200);
    };
    const videoLoop = () => p.evaluate(() => document.querySelector('video').loop);
    const fields = () => p.evaluate(m =>
        [...document.querySelectorAll(m + ' input')].map(i => i.value).join(' | '), MENU);
    const stored = () => p.evaluate(() => __s.sekhmet_loopedVideos || {});

    await shot(p, 'loop-menu.png');
    await clickBtn('Loop this video');

    console.log('--- switching the loop on');
    const inputs = await p.$$(MENU + ' input');
    check('turning the loop on shows start and end fields', inputs.length === 2, inputs.length);
    check('the menu stays open', !!(await p.$(MENU)));
    check('the whole video loops before a range is set', await videoLoop() === true);

    const status = () => p.evaluate(m =>
        document.querySelector(m + ' input').closest('div').parentElement.lastChild.textContent, MENU);
    const setI = async (i, t) => {
        await inputs[i].click({ clickCount: 3 });
        await p.keyboard.type(t);
        await p.keyboard.press('Enter');
        await sleep(150);
    };

    console.log('--- typing a range');
    await p.evaluate(() => { window.__kd = 0; document.addEventListener('keydown', () => window.__kd++); });
    await setI(0, '0:02');
    await setI(1, '5');
    let s = await status();
    check('start 0:02 and end 5 make a range', s === 'Looping 0:02 – 0:05', s);
    const range = (await stored()).AAA;
    check('the range is stored with the video', range && range.start === 2 && range.end === 5, range);
    const kd = await p.evaluate(() => __kd);
    check('typing in the fields does not reach page shortcuts', kd === 0, kd);
    await shot(p, 'loop-range.png');

    const samples = await p.evaluate(() => new Promise(res => {
        const v = document.querySelector('video');
        const out = [];
        const t0 = performance.now();
        let last = v.currentTime, wraps = 0, peak = 0;
        const id = setInterval(() => {
            const c = v.currentTime;
            if (c < last - 1) { wraps++; peak = Math.max(peak, last); }
            last = c;
            if (wraps > 0 || c <= 5.5) out.push(c);
            if (performance.now() - t0 > 11000) {
                clearInterval(id);
                res({ min: Math.min(...out), max: Math.max(...out), wraps, peak, paused: v.paused });
            }
        }, 15);
    }));
    check('playback wraps back to the start at least twice in 11s', samples.wraps >= 2, samples);
    check('playback stays inside 0:02 – 0:05 (with 0.3s slack)', samples.min >= 1.9 && samples.max <= 5.3, samples);
    check('the video keeps playing', samples.paused === false, samples);
    const row = await p.evaluate(() =>
        (document.querySelector('#sekhmet-ft-status-rows').innerText.match(/Loop\s+.*/) || [''])[0]);
    check('the status row shows the range', /0:02/.test(row) && /0:05/.test(row), row);

    console.log('--- checking typed times');
    await setI(0, '10');
    s = await status();
    check('a start after the end is refused', !s.startsWith('Looping'), s);
    await setI(1, '0:15');
    s = await status();
    check('fixing the end saves both', s === 'Looping 0:10 – 0:15', s);
    await setI(1, '99');
    s = await status();
    check('an end past the video is refused', s === 'The video is only 0:30 long.', s);
    await setI(1, 'abc');
    s = await status();
    check('an end that is not a time is refused', s === 'End should look like 1:23.', s);
    await setI(1, '15');

    console.log('--- paused playhead');
    await p.evaluate(() => { document.querySelector('video').pause(); });
    await sleep(100);
    await p.evaluate(() => { document.querySelector('video').currentTime = 20; });
    await sleep(300);
    const at = await p.evaluate(() => document.querySelector('video').currentTime);
    check('a paused playhead may leave the range', at === 20, at);

    const nowBtn = await p.evaluateHandle(m =>
        [...document.querySelectorAll(m + ' button')].filter(x => x.textContent === 'Use current time')[1], MENU);
    await nowBtn.click();
    await sleep(150);
    s = await status();
    check('"Use current time" sets the end to the playhead', s === 'Looping 0:10 – 0:20' && (await fields()) === '0:10 | 0:20', s);

    console.log('--- timeline bar');
    const barBox = await (await p.$('#sekhmet-loop-timeline')).boundingBox();
    const xAt = r => barBox.x + barBox.width * r;
    const yBar = barBox.y + barBox.height / 2;
    const saved = async () => (await stored()).AAA;

    await p.mouse.click(xAt(0.1), yBar); await sleep(150);
    let f = await fields();
    check('a click near the start moves the start', f === '0:03 | 0:20', f);
    await p.mouse.click(xAt(0.9), yBar); await sleep(150);
    f = await fields();
    check('a click near the end moves the end', f === '0:03 | 0:27', f);

    await p.mouse.move(xAt(0.1), yBar);
    await p.mouse.down();
    await p.mouse.move(xAt(0.5), yBar, { steps: 6 });
    f = await fields();
    const mid = await saved();
    check('dragging updates the field live', f === '0:15 | 0:27', f);
    check('nothing is saved mid-drag', mid.start === 3 && mid.end === 27, mid);
    await p.mouse.up(); await sleep(150);
    const after = await saved();
    check('releasing the drag saves it', after.start === 15 && after.end === 27, after);

    await p.mouse.move(xAt(0.9), yBar);
    await p.mouse.down();
    await p.mouse.move(xAt(0.2), yBar, { steps: 6 });
    await p.mouse.up(); await sleep(150);
    f = await fields();
    check('dragging the end past the start clamps it after the start', f === '0:15 | 0:16', f);

    await p.mouse.click(xAt(0.995), yBar); await sleep(150);
    s = await status();
    check('a click at the far right means "to the end"', s === 'Looping 0:15 – end' && (await fields()) === '0:15 | ', s);
    await shot(p, 'loop-timeline.png');

    console.log('--- whole video and off');
    await clickBtn('Loop the whole video');
    const span = await p.evaluate(() => {
        const k = [...document.querySelector('#sekhmet-loop-timeline').children];
        return k[3].style.left + ' .. ' + k[4].style.left;
    });
    check('the bar shows the whole video', span === '0% .. 100%', span);
    s = await status();
    const whole = await stored();
    check('"Loop the whole video" stores a plain timestamp', s === 'Looping the whole video' && typeof whole.AAA === 'number', whole);

    await clickBtn('Stop looping');
    const left = (await p.$$(MENU + ' input')).length;
    check('turning the loop off hides the fields and stops looping', left === 0 && (await videoLoop()) === false, left);

    console.log('--- menu edge cases');
    await clickBtn('Loop this video');
    const bar2 = await (await p.$('#sekhmet-loop-timeline')).boundingBox();
    await p.mouse.click(bar2.x + bar2.width * 0.5, bar2.y + bar2.height / 2, { button: 'right' });
    await sleep(150);
    f = await fields();
    check('a right click on the bar changes nothing', f === '0:00 | ', f);

    const input = await (await p.$(MENU + ' input')).boundingBox();
    await p.mouse.move(input.x + 20, input.y + input.height / 2);
    await p.mouse.down();
    await p.mouse.move(40, 900, { steps: 4 });
    await p.mouse.up();
    await sleep(150);
    check('a text drag released on the backdrop keeps the menu open', !!(await p.$(MENU)));

    await p.evaluate(() => history.pushState({}, '', '/watch?v=BBB'));
    await sleep(1300);
    const n = (await p.$$(MENU + ' input')).length;
    const label = await p.evaluate(m =>
        [...document.querySelectorAll(m + ' button')].find(x => x.textContent.includes('oop')).textContent, MENU);
    check('navigating redraws the open menu for the new video', n === 0 && /Loop this video/.test(label), { n, label });
    await clickBtn('Loop this video');
    const keys = Object.keys(await stored());
    check('the toggle lands on the new video', keys.includes('BBB'), keys);

    check('no page errors', pageErrors.length === 0, pageErrors);
}));
