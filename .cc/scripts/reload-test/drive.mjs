// Driver for guard.sh: loads an extension into the guarded Brave, reloads it
// one way, then watches for 30 seconds. It never starts or kills Brave, and it
// never creates or deletes files: guard.sh makes the extension copy and
// removes it, because guard.sh may SIGKILL this script at any moment.
// Usage (from guard.sh): node drive.mjs <scenario> <port> <extension dir>
//   button    - Sekhmet, reloaded the way the extensions page's Reload button does
//   self      - Sekhmet, reloaded by its own background page: runtime.reload()
//   mini-self - a two-file extension doing the same, to see if it is Sekhmet
//   button-tabs, self-tabs - the same as button and self, with a YouTube video
//             and an x.com post open while it reloads, and both tabs refreshed
//             2 seconds after, as dev-reload.js did. Closest to the incidents.
//   devreload-tabs - the copy has dev-reload.js in its manifest, as during the
//             second incident. The reload is sent through the pipe with
//             native-host/reload-extension, and dev-reload.js refreshes the tabs.
//   devreload-sleeping-tabs - 16 light tabs, 4 of them put to sleep (discarded)
//             first. Shows which tabs dev-reload.js refreshes: your own Brave
//             had about 1,290 matching tabs, nearly all asleep, and the first
//             dev-reload.js woke every one of them at once. Now it refreshes none.
//   button-toast-tabs, devreload-toast-tabs - a DuckDuckGo and a YouTube tab;
//             reload (button, or through the pipe), check both show the
//             "click to reload" toast and neither reloads by itself, click it
//             in one, then reload again: the reloaded tab must show it again.
//   guarded-tabs - the same, sent with native-host/reload-guarded, which then
//             watches this Brave for 20 seconds.
//   guarded-runaway - the same, plus a tab that eats about 1 GB after the
//             reload, against a 600 MB limit: reload-guarded must quit Brave.
//   guarded-orphan - guarded-runaway, but the command that started the guard
//             is killed (its group, then each process) 3 s in, as when a Claude
//             Bash call is stopped: the guard must still quit Brave.
//   guarded-wake - the same, but 6 new tabs open after the reload, against a
//             limit of 3 new page processes: reload-guarded must quit Brave.
//             This is the incidents' failure (sleeping tabs loaded), small.
const [scenario, port, extDir] = process.argv.slice(2);
import { execFileSync, spawn } from 'node:child_process';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPO = new URL('../../..', import.meta.url).pathname;
const hosts = () => { try { return execFileSync('pgrep', ['-f', '[Pp]ython[0-9.]* /.*/dev_reload_host\\.py$'], { encoding: 'utf8' }).trim().split('\n').join(','); } catch { return 'none'; } };
const base = `http://127.0.0.1:${port}`;
const list = async () => (await fetch(`${base}/json/list`)).json();

async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    let id = 0; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    const evaluate = async x => {
        const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
        return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
    };
    return { send, evaluate, close: () => ws.close() };
}

let up = false;
for (let i = 0; i < 50 && !up; i++) { try { await fetch(`${base}/json/version`); up = true; } catch { await sleep(200); } }
if (!up) { throw new Error('Brave never opened its debugging port'); }
const browser = await connect((await (await fetch(`${base}/json/version`)).json()).webSocketDebuggerUrl);

// Developer mode first: a fresh profile has it off, and then a reload disables
// an unpacked extension instead of reloading it - not the path your Brave takes.
const page = await connect((await list()).find(t => t.type === 'page').webSocketDebuggerUrl);
await page.send('Page.enable');
await page.send('Page.navigate', { url: 'chrome://extensions' });
await sleep(1500);
await page.evaluate(`chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}).then(() => 'ok', e => String(e))`);
console.log('developer mode:', await page.evaluate(`chrome.developerPrivate.getProfileConfiguration().then(c => c.inDeveloperMode)`));

// The pipe is shared with your own Brave. A helper that runs before this test
// loads its extension belongs to another Brave, which a reload sent here would
// reach too.
if ((scenario.startsWith('devreload') || scenario.startsWith('guarded')) && hosts() !== 'none') {
    throw new Error('a pipe helper is already running (' + hosts() + '): another Brave listens on the pipe, not sending a reload');
}
const loaded = await browser.send('Extensions.loadUnpacked', { path: extDir });
const extId = loaded.result?.id;
if (!extId) { throw new Error('load failed: ' + JSON.stringify(loaded.error)); }
console.log('loaded:', extId);
await sleep(2000);

const state = () => page.evaluate(`chrome.developerPrivate.getExtensionsInfo({includeDisabled: true, includeTerminated: true})
    .then(l => l.filter(e => e.id === '${extId}').map(e => e.state + ' ' + Object.entries(e.disableReasons).filter(([, v]) => v).map(([k]) => k).join(',')).join(''))`);
const backgrounds = async () => (await list()).filter(x => x.type === 'background_page' && x.url.includes(extId));
console.log('before reload:', await state(), '| background pages:', (await backgrounds()).length);

// A mark in the background page's globals. A real reload starts a new page
// without it; the same page still having it means nothing reloaded.
async function marked() {
    const [bg] = await backgrounds();
    if (!bg) { return 'no background page'; }
    const b = await connect(bg.webSocketDebuggerUrl);
    const v = await b.evaluate('window.__reloadTestMark === 1 ? "old page (not reloaded)" : "new page (reloaded)"');
    b.close();
    return v;
}
{
    const [bg] = await backgrounds();
    const b = await connect(bg.webSocketDebuggerUrl);
    await b.evaluate('window.__reloadTestMark = 1');
    b.close();
}

if (scenario.endsWith('-toast-tabs')) {
    const names = ['duckduckgo', 'youtube'];
    const ids = [];
    for (const url of ['https://duckduckgo.com/?q=sekhmet', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']) {
        ids.push((await browser.send('Target.createTarget', { url })).result.targetId);
    }
    await sleep(10000);
    const inTab = async (id, expr) => {
        const t = (await list()).find(x => x.id === id);
        if (!t) { return 'tab gone'; }
        const c = await connect(t.webSocketDebuggerUrl);
        const v = await Promise.race([c.evaluate(expr), sleep(3000).then(() => 'no answer')]);
        c.close();
        return String(v);
    };
    const markTab = id => inTab(id, 'window.__tabMark = 1; "marked"');
    const report = async label => {
        const parts = [];
        for (const [i, id] of ids.entries()) {
            const toast = await inTab(id, `(document.getElementById('sekhmet-toast-container') || {}).innerText || 'no toast'`);
            parts.push(`${names[i]}: ${toast.replace(/\s+/g, ' ')} / ${await inTab(id, 'window.__tabMark === 1 ? "not reloaded" : "reloaded"')}`);
        }
        console.log(`${label}: ${parts.join(' | ')}`);
    };
    const reload = async () => scenario.startsWith('devreload')
        ? execFileSync(`${REPO}native-host/reload-extension`, ['lib.js'], { encoding: 'utf8', timeout: 5000, cwd: REPO }).trim()
        : page.evaluate(`chrome.developerPrivate.reload('${extId}', {failQuietly: true}).then(() => 'ok', e => String(e))`);
    for (const id of ids) { await markTab(id); }
    await report('before reload');
    console.log('reload 1:', await reload());
    await sleep(3000);
    await report('+3s');
    console.log('click the duckduckgo toast:', await inTab(ids[0], `(() => { const t = document.querySelector('#sekhmet-toast-container > div'); if (!t) { return 'no toast'; } t.click(); return 'clicked'; })()`));
    await sleep(6000);
    await report('+6s after the click');
    await markTab(ids[0]);
    console.log('reload 2:', await reload());
    await sleep(3000);
    await report('+3s after reload 2');
    console.log('extension:', await state(), '| background pages:', (await backgrounds()).length, '| pipe helper:', hosts());
    process.exit(0);
}

// The sleeping-tab scenarios ask the extension itself about its tabs, because a
// discarded tab has no page for DevTools to talk to.
const SLEEPING = scenario === 'devreload-sleeping-tabs';
const LIGHT_TABS = 16, ASLEEP = 4;
async function bgEval(expr) {
    const [bg] = await backgrounds();
    if (!bg) { return 'no background page'; }
    const b = await connect(bg.webSocketDebuggerUrl);
    const v = await b.evaluate(expr);
    b.close();
    return v;
}
const lightTabs = () => bgEval(`new Promise(r => chrome.tabs.query({ url: '*://example.com/*' }, ts => r(ts.map(t => ({ id: t.id, n: +new URL(t.url).searchParams.get('tab'), status: t.status, discarded: t.discarded, active: t.active })))))`);
// "asleep 4, loaded 12" - and which of the loaded ones were refreshed, by a
// mark put on each page before the reload.
const marks = new Map();
async function lightState() {
    const ts = await lightTabs();
    if (!Array.isArray(ts)) { return String(ts); }
    const asleep = ts.filter(t => t.status === 'unloaded' || t.discarded).length;
    let refreshed = 0, kept = 0;
    for (const t of (await list()).filter(x => marks.has(x.id))) {
        const c = await connect(t.webSocketDebuggerUrl);
        const v = await Promise.race([c.evaluate('window.__tabMark === 1'), sleep(2000).then(() => null)]);
        c.close();
        if (v === true) { kept++; } else if (v === false) { refreshed++; }
    }
    return `tabs ${ts.length}: asleep ${asleep}, loaded ${ts.length - asleep} | of the ${marks.size} loaded before: refreshed ${refreshed}, not refreshed ${kept}`;
}
if (SLEEPING) {
    for (let i = 1; i <= LIGHT_TABS; i++) { await browser.send('Target.createTarget', { url: `https://example.com/?tab=${i}`, background: true }); }
    await sleep(8000);
    const before = await lightTabs();
    const toSleep = before.filter(t => !t.active).sort((a, b) => a.n - b.n).slice(0, ASLEEP).map(t => t.id);
    console.log('discard:', await bgEval(`Promise.all(${JSON.stringify(toSleep)}.map(id => new Promise(r => chrome.tabs.discard(id, () => r(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'ok')))))`));
    await sleep(2000);
    const awake = new Set((await lightTabs()).filter(t => t.status !== 'unloaded' && !t.discarded).map(t => t.n));
    for (const t of (await list()).filter(x => x.type === 'page' && x.url.includes('example.com/?tab='))) {
        if (!awake.has(+new URL(t.url).searchParams.get('tab'))) { continue; }
        const c = await connect(t.webSocketDebuggerUrl);
        await Promise.race([c.evaluate('window.__tabMark = 1'), sleep(2000)]);
        c.close();
        marks.set(t.id, true);
    }
    console.log('before reload:', await lightState());
}

const TAB_URLS = ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://x.com/justalexoki/status/2103841051228418113'];
const tabs = [];
if (!SLEEPING && (scenario.endsWith('-tabs') || scenario === 'guarded-runaway' || scenario === 'guarded-wake' || scenario === 'guarded-orphan')) {
    for (const url of TAB_URLS) {
        const { result } = await browser.send('Target.createTarget', { url });
        tabs.push(result.targetId);
    }
    await sleep(10000);
    const open = (await list()).filter(t => tabs.includes(t.id));
    console.log('tabs open:', open.map(t => t.url.slice(0, 50)).join(' , '));
    for (const t of open) { const c = await connect(t.webSocketDebuggerUrl); await c.evaluate('window.__tabMark = 1'); c.close(); }
}
// Whether each tab has been refreshed since the mark went on.
async function tabState() {
    const out = [];
    for (const t of (await list()).filter(x => tabs.includes(x.id))) {
        const c = await connect(t.webSocketDebuggerUrl);
        out.push((t.url.includes('youtube') ? 'youtube ' : 'x.com ') + (await c.evaluate('window.__tabMark === 1 ? "not refreshed" : "refreshed"')));
        c.close();
    }
    return out.join(', ');
}

if (scenario.startsWith('guarded')) {
    // Not awaited here: it watches for 20 s while the rest of this runs.
    // The log goes into the test's temp folder, which guard.sh removes.
    const env = { ...process.env, RELOAD_WATCH_S: '20', RELOAD_LOG: `${extDir}/../reload-guarded.log` };
    if (scenario === 'guarded-runaway' || scenario === 'guarded-orphan') { env.RELOAD_MAX_GROWTH_MB = '600'; }
    if (scenario === 'guarded-wake') { env.RELOAD_MAX_NEW_TABS = '3'; }
    // Own process group, so guarded-orphan can kill it the way Claude Code
    // stops a Bash call: the group, then each process.
    const child = spawn(`${REPO}native-host/reload-guarded`, ['x.css', 'lib.js'], { cwd: REPO, env, detached: true });
    let out = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
    const done = new Promise(r => child.on('exit', code => r(code)));
    console.log('reload: sent through reload-guarded');
    if (scenario === 'guarded-orphan') {
        await sleep(3000);
        const pids = execFileSync('pgrep', ['-g', String(child.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { console.log('group kill:', e.message); }
        for (const p of pids) { try { process.kill(+p, 'SIGKILL'); } catch {} }
        console.log(`starter killed: group ${child.pid} (${pids.length} processes)`);
    }
    if (scenario === 'guarded-runaway' || scenario === 'guarded-orphan') {
        await sleep(scenario === 'guarded-orphan' ? 2000 : 5000);
        const t = (await list()).find(x => x.type === 'page' && x.url.includes('x.com'));
        const c = await connect(t.webSocketDebuggerUrl);
        // 128 MB a step, every 300 ms, written to so the pages are real.
        c.send('Runtime.evaluate', { expression: `window.__hog = []; (function step() { if (__hog.length < 8) { __hog.push(new Float64Array(16e6).fill(1)); setTimeout(step, 300); } })(); 'eating'` });
        console.log('runaway started in the x.com tab');
    }
    if (scenario === 'guarded-wake') {
        await sleep(5000);
        for (let i = 1; i <= 6; i++) { browser.send('Target.createTarget', { url: `https://example.com/?tab=${i}`, background: true }); }
        console.log('6 new tabs opened');
    }
    const code = await done;
    if (scenario === 'guarded-orphan') {
        // The guard must still quit this Brave, with no starter left to report it.
        const { readFileSync } = await import('node:fs');
        let log = '';
        for (let i = 0; i < 40 && !/reload-guarded: exit \d+$/m.test(log); i++) {
            await sleep(500);
            try { log = readFileSync(env.RELOAD_LOG, 'utf8'); } catch {}
        }
        console.log('starter exit', code, '| guard log:\n' + log.trim());
        process.exit(0);
    }
    console.log('reload-guarded exit', code, '\n' + out.trim());
    process.exit(0);
} else if (scenario.startsWith('devreload')) {
    console.log('pipe helper before reload:', hosts());
    // picker-target.js is in the content script that matches every site.
    const args = scenario === 'devreload-tabs' ? ['x.css', 'lib.js'] : ['picker-target.js'];
    try {
        console.log('reload:', execFileSync(`${REPO}native-host/reload-extension`, args, { encoding: 'utf8', timeout: 5000, cwd: REPO }).trim());
    } catch (e) {
        throw new Error('reload-extension failed: ' + (e.stderr || e.message));
    }
} else if (scenario.startsWith('button')) {
    console.log('reload:', await page.evaluate(`chrome.developerPrivate.reload('${extId}', {failQuietly: true}).then(() => 'ok', e => String(e))`));
} else {
    const [bg] = await backgrounds();
    if (!bg) { throw new Error('no background page to reload from'); }
    const b = await connect(bg.webSocketDebuggerUrl);
    b.send('Runtime.evaluate', { expression: 'setTimeout(() => chrome.runtime.reload(), 100); "sent"' });
    await sleep(300);
    b.close();
    console.log('reload: runtime.reload() sent');
}

if (tabs.length && !scenario.startsWith('devreload')) {
    await sleep(2000);
    for (const id of tabs) {
        const t = (await list()).find(x => x.id === id);
        if (!t) { console.log('tab gone:', id); continue; }
        const c = await connect(t.webSocketDebuggerUrl);
        await c.send('Page.reload');
        c.close();
    }
    console.log('tabs refreshed');
}

let last = 0;
for (const t of [2, 5, 10, 20, 30]) {
    await sleep((t - last) * 1000); last = t;
    console.log(`+${t}s: ${await state()} | background pages: ${(await backgrounds()).length} | ${await marked()}${scenario.startsWith('devreload') ? ' | pipe helper: ' + hosts() : ''}${tabs.length ? ' | ' + await tabState() : ''}${SLEEPING ? ' | ' + await lightState() : ''}`);
}

// Open DevTools sockets would keep node alive until the guard's deadline.
process.exit(0);
