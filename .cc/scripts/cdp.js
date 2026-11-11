// Minimal Chrome DevTools Protocol driver for probing real sites from node.
// Launches headless Chrome with a throwaway profile, then exposes
// open(url) -> {eval(expr), close()}. Node 22+ (global WebSocket).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch({ port = 9333, width = 1400, height = 1000 } = {}) {
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
    const proc = spawn(CHROME, [
        '--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`,
        `--user-data-dir=${prof}`, `--window-size=${width},${height}`, 'about:blank'
    ], { stdio: 'ignore' });
    let targets;
    for (let i = 0; i < 50; i++) {
        try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; }
        catch { await sleep(200); }
    }
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', e => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise(r => {
        const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params }));
    });
    const evaluate = async expr => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
        return r.result && r.result.result && r.result.result.value;
    };
    return {
        send, eval: evaluate, sleep,
        async goto(url, wait = 8000) { await send('Page.enable'); await send('Page.navigate', { url }); await sleep(wait); },
        close() { try { ws.close(); } catch {} proc.kill(); setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} }, 500); }
    };
}
module.exports = { launch, sleep };
