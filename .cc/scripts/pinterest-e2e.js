// Drives pinterest.js on a real (logged-out) Pinterest page in headless Chrome.
// Usage: node .cc/scripts/pinterest-e2e.js [url] [outdir]
// Prints, per scroll position (down, then back to the top), how many pins are
// cut off and veiled, whole and veiled (should be none), and below the window
// but not veiled (should be none until scrolled back). Writes screenshots.
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..', '..');
const url = process.argv[2] || 'https://www.pinterest.com/search/pins/?q=landscape%20painting';
const out = process.argv[3] || '.';

const inject = `(() => {
  const st = document.createElement('style');
  st.textContent = ${JSON.stringify(fs.readFileSync(path.join(ROOT, 'pinterest.css'), 'utf8'))};
  document.head.appendChild(st);
  ${fs.readFileSync(path.join(ROOT, 'lib.js'), 'utf8').match(/function initLogger[\s\S]*?\n}\n/)[0]}
  ${fs.readFileSync(path.join(ROOT, 'pinterest.js'), 'utf8').replace(/^let PinterestPeek/, 'window.PinterestPeek')}
})()`;

const check = `(() => {
  const items = [...document.querySelectorAll('[data-grid-item="true"]')];
  const rows = items.map(i => { const r = (i.querySelector('[data-sekhmet-media]') || i).getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), veiled: i.hasAttribute('data-sekhmet-veiled'),
      imgOpacity: getComputedStyle(i.querySelector('img') || i).opacity }; });
  const cut = rows.filter(r => r.top < innerHeight && r.bottom > innerHeight + 0.5);
  const whole = rows.filter(r => r.top >= 0 && r.bottom <= innerHeight + 0.5);
  return { scrollY, items: rows.length, cutOff: cut.length, cutOffVeiled: cut.filter(r => r.veiled).length,
    whole: whole.length, wholeButVeiled: whole.filter(r => r.veiled).length,
    belowUnveiled: rows.filter(r => r.top >= innerHeight && !r.veiled).length };
})()`;

const unblock = `document.querySelectorAll('body *').forEach(e => { const cs = getComputedStyle(e); if (cs.position === 'fixed' && e.getBoundingClientRect().height > innerHeight * 0.5) e.style.display = 'none'; })`;

(async () => {
    const b = await launch({ width: 1400, height: 1000 });
    const shot = async name => {
        const r = await b.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(out, name), Buffer.from(r.result.data, 'base64'));
    };
    try {
        await b.goto(url);
        await b.eval(inject);
        await b.eval(unblock);
        for (const y of [0, 250, 500, 0]) {
            await b.eval(`window.scrollTo(0, ${y})`);
            await sleep(1400);
            console.log(JSON.stringify(await b.eval(check)));
            await shot(`peek-${y}-${Date.now() % 1000}.png`);
        }
    } finally { b.close(); }
})();
