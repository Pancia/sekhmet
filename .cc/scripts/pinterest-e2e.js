// Drives the real Sekhmet extension on a real (logged-out) Pinterest page in
// headless Brave, which loads the repo as an unpacked extension (headless
// Google Chrome ignores --load-extension). So the manifest entry, the
// stylesheet injected before first paint, and pinterest.js at document_end
// are all the real thing, in the content script's own world.
// Usage: node .cc/scripts/pinterest-e2e.js [url] [outdir]
// Prints PASS/FAIL lines and, per scroll position (down, then back to the
// top), how many pins are cut off and veiled, whole and veiled, and below the
// window but not veiled. Writes screenshots to outdir. Exits 1 on any FAIL.
//
// Logged out, the feed stops at about 21 pins and body has overflow:hidden,
// so a person cannot scroll it by hand. scrollTo still works. Pinterest
// removes pins its own layout puts off screen (items carry
// data-grid-item-idx), so counts change between scroll positions.
const fs = require('fs');
const path = require('path');
const { launch, sleep, BRAVE } = require('./cdp.js');

// SEKHMET_ROOT loads another copy, e.g. to check that a reverted fix fails.
const ROOT = process.env.SEKHMET_ROOT || path.resolve(__dirname, '..', '..');
const url = process.argv[2] || 'https://www.pinterest.com/search/pins/?q=landscape%20painting';
const out = process.argv[3] || '.';

let failed = 0;
function check(label, cond, detail) {
    if (!cond) { failed++; }
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${JSON.stringify(detail)})`}`);
}

// Runs before Pinterest's own scripts, in the page's world. When the first
// pin picture appears, and before pinterest.js has marked its item, it reads
// the picture's opacity (the stylesheet's hold should make it 0), then marks
// the item for a moment to read the opacity without the hold. A control of 0
// would mean Pinterest hides it too, and the hold could not be told apart.
const early = `(() => {
  const look = () => {
    const img = document.querySelector('[data-grid-item] img, [role="list"] > [role="listitem"] img');
    if (!img) { return false; }
    const item = img.closest('[data-grid-item]') || img.closest('[role="listitem"]');
    const pinned = item.hasAttribute('data-sekhmet-pin');
    const held = getComputedStyle(img).opacity;
    if (!pinned) { item.setAttribute('data-sekhmet-pin', 'probe'); }
    const control = getComputedStyle(img).opacity;
    if (!pinned) { item.removeAttribute('data-sekhmet-pin'); }
    window.__sekhmetEarly = { held, control, pinned, readyState: document.readyState };
    return true;
  };
  new MutationObserver((_, mo) => { if (look()) { mo.disconnect(); } })
    .observe(document, { childList: true, subtree: true });
})()`;

// Pins this measures as pinterest.js does: by the box it veils, else the item.
// Excused from the cut-off check, as pinterest.js shows them at once: pins
// taller than most of the window, wide items, and items with no key.
const measure = `(() => {
  const items = [...document.querySelectorAll('[data-grid-item]')];
  const column = Math.min(...items.map(i => i.getBoundingClientRect().width).filter(w => w > 0));
  const rows = items.filter(i => i.getAttribute('data-sekhmet-pin') !== 'off').map(i => {
    const r = (i.querySelector('[data-sekhmet-media]') || i).getBoundingClientRect();
    const media = i.querySelector('img, video');
    const keyless = !i.querySelector('a[href*="/pin/"]') && !(media && (media.currentSrc || media.getAttribute('src') || media.getAttribute('poster')));
    return { top: r.top, bottom: r.bottom, height: r.height, veiled: i.hasAttribute('data-sekhmet-veiled'),
      excused: keyless || r.height > innerHeight * 0.8 || i.getBoundingClientRect().width > column * 1.5 };
  }).filter(r => r.height > 0);
  const cut = rows.filter(r => r.top < innerHeight && r.bottom > innerHeight + 0.5 && !r.excused);
  const whole = rows.filter(r => r.top >= -0.5 && r.bottom <= innerHeight + 0.5);
  return { scrollY, items: items.length, marked: document.querySelectorAll('[data-sekhmet-pin]').length,
    cutOff: cut.length, cutOffUnveiled: cut.filter(r => !r.veiled).length,
    whole: whole.length, wholeButVeiled: whole.filter(r => r.veiled).length,
    belowUnveiled: rows.filter(r => r.top >= innerHeight && !r.veiled && !r.excused).length };
})()`;

const unblock = `document.querySelectorAll('body *').forEach(e => { const cs = getComputedStyle(e); if (cs.position === 'fixed' && e.getBoundingClientRect().height > innerHeight * 0.5) e.style.display = 'none'; })`;

(async () => {
    const b = await launch({ width: 1400, height: 1000, browser: BRAVE, extension: ROOT });
    const shot = async name => {
        const r = await b.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(out, name), Buffer.from(r.result.data, 'base64'));
    };
    try {
        const ext = (await b.targets()).filter(t => t.url.startsWith('chrome-extension://'));
        check('the unpacked extension is loaded', ext.length > 0, ext.map(t => t.type));

        await b.send('Page.enable');
        await b.send('Page.addScriptToEvaluateOnNewDocument', { source: early });
        await b.goto(url);

        const e = await b.eval('window.__sekhmetEarly || null');
        check('a pin picture was seen before pinterest.js marked it', !!e && !e.pinned, e);
        check('the stylesheet holds that picture back (opacity 0)', !!e && e.held === '0', e && e.held);
        check('without the hold it would show (so the hold is ours)', !!e && e.control !== '0', e && e.control);

        await b.eval(unblock);
        // Down first: a pin cut off at the bottom has never been wholly on
        // screen, so it must be veiled. Back at the top, pins seen lower down
        // stay shown, so only "whole but veiled" is checked there.
        const stops = [0, 250, 500, 0];
        for (let n = 0; n < stops.length; n++) {
            const y = stops[n];
            const down = n < stops.length - 1;
            await b.eval(`window.scrollTo(0, ${y})`);
            await sleep(1400);
            const m = await b.eval(measure);
            console.log(JSON.stringify(m));
            const at = `at ${m.scrollY}${down ? '' : ' (back up)'}`;
            if (n === 0) {
                check('pinterest.js marked the pins', m.items > 0 && m.marked >= m.items, { items: m.items, marked: m.marked });
                check('some pin is cut off at the bottom, so the check has something to check', m.cutOff > 0, m.cutOff);
            }
            check(`${at}: no whole pin is veiled`, m.wholeButVeiled === 0, m.wholeButVeiled);
            if (down) {
                check(`${at}: every cut-off pin is veiled`, m.cutOffUnveiled === 0, m.cutOffUnveiled);
            }
            await shot(`peek-${n}-${y}.png`);
        }
    } finally {
        b.close();
        console.log(failed ? `\n${failed} FAILED` : '\nall pass');
        process.exitCode = failed ? 1 : 0;
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
