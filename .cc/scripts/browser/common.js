// Shared setup for the browser fixtures: paths, the browser, PASS/FAIL checks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

// SEKHMET_ROOT runs the fixtures against another copy, e.g. to check that a
// reverted fix makes them fail.
const ROOT = process.env.SEKHMET_ROOT || path.resolve(__dirname, '../../..');
const OUT = path.join(__dirname, 'out');
// The fixtures inject the content scripts themselves, so any Chromium works.
// Google Chrome is the default; SEKHMET_BROWSER points at another (e.g. Brave).
const BROWSER = process.env.SEKHMET_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0;
const failed = [];

function check(label, cond, detail) {
    if (cond) {
        passed++;
        console.log(`PASS  ${label}`);
    } else {
        failed.push(label);
        console.log(`FAIL  ${label}${detail === undefined ? '' : `  (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
    }
}

// Screenshots go to out/, which git ignores. Look at them after a run.
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

async function withBrowser(fn) {
    fs.mkdirSync(OUT, { recursive: true });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sekhmet-fixture-'));
    const b = await puppeteer.launch({
        executablePath: BROWSER,
        headless: true,
        userDataDir: profile,
        args: ['--autoplay-policy=no-user-gesture-required']
    });
    try {
        await fn(b);
    } finally {
        await b.close().catch(() => {});
        fs.rmSync(profile, { recursive: true, force: true });
    }
}

function finish() {
    console.log(`\n${passed} passed, ${failed.length} failed`);
    if (failed.length) {
        console.log('FAILED:\n  ' + failed.join('\n  '));
        process.exit(1);
    }
}

function run(main) {
    main().then(finish).catch(e => {
        console.error(e);
        process.exit(1);
    });
}

module.exports = { ROOT, OUT, sleep, check, shot, withBrowser, run };
