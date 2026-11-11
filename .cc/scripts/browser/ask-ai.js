// ✨ Ask button: opens a fake YouTube Ask panel and sends the prompt. The fake
// copies what YouTube's bundle shows: the panel is target-id "PAyouchat", the
// input is a textarea in yt-chat-input-view-model, the form's send button is
// disabled while the welcome message loads, and the entry button's
// button-view-model has the class "you-chat-entrypoint-button". It checks our
// logic against that reading of the bundle, not against the live site.
const fs = require('fs');
const path = require('path');
const { ROOT, sleep, check, shot, withBrowser, run } = require('./common');

const PROMPT = 'Summarize this video.\n\n## Summary\nTwo short paragraphs.';

// ?ask=tagged|labelled|none  ?open=1 (panel already open)  ?prompt=fail
const html = `<!doctype html><html><body style="margin:0;background:#fff">
<div id="center" class="ytd-masthead" style="height:56px;display:flex"></div>
<ytd-watch-flexy style="display:block">
  <ytd-watch-metadata style="display:block"><div id="actions"></div></ytd-watch-metadata>
  <ytd-engagement-panel-section-list-renderer target-id="PAyouchat" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN" style="display:none">
    <div id="content"></div>
  </ytd-engagement-panel-section-list-renderer>
</ytd-watch-flexy>
<script>
  const q = new URLSearchParams(location.search);
  window.__fake = { entryClicks: 0, sent: [] };
  const panel = document.querySelector('[target-id="PAyouchat"]');
  function openPanel() {
    panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
    panel.style.display = 'block';
    setTimeout(() => {
      if (panel.querySelector('textarea')) return;
      const vm = document.createElement('yt-chat-input-view-model');
      vm.style.display = 'block';
      vm.innerHTML = '<div><form><textarea rows="1"></textarea><button-view-model><button disabled>Send</button></button-view-model></form></div>';
      panel.querySelector('#content').append(vm);
      const ta = vm.querySelector('textarea'), send = vm.querySelector('button');
      let loading = true;
      const submit = () => { if (loading) return; window.__fake.sent.push(ta.value); ta.value = ''; send.disabled = true; };
      ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !loading) { e.preventDefault(); submit(); } e.stopPropagation(); });
      ta.addEventListener('keyup', e => { if (!loading) send.disabled = ta.value.length === 0; e.stopPropagation(); });
      send.addEventListener('click', e => { e.preventDefault(); submit(); });
      setTimeout(() => { loading = false; send.disabled = ta.value.length === 0; }, 1500);
    }, 300);
  }
  const ask = q.get('ask') || 'tagged';
  if (ask !== 'none') {
    const bvm = document.createElement('button-view-model');
    if (ask === 'tagged') bvm.className = 'you-chat-entrypoint-button';
    bvm.innerHTML = ask === 'tagged' ? '<button>Ask</button>' : '<button aria-label="Ask">✦</button>';
    document.getElementById('actions').append(bvm);
    bvm.querySelector('button').addEventListener('click', () => {
      window.__fake.entryClicks++;
      if (panel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
        panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'); panel.style.display = 'none';
      } else openPanel();
    });
  }
  if (q.get('open') === '1') openPanel();
</script></body></html>`;

run(() => withBrowser(async b => {
    async function scenario(query) {
        const p = await b.newPage();
        await p.setViewport({ width: 1100, height: 800 });
        const pageErrors = [];
        p.on('pageerror', e => pageErrors.push(e.message));
        await p.setRequestInterception(true);
        p.on('request', r => r.url().includes('/watch')
            ? r.respond({ status: 200, contentType: 'text/html', body: html })
            : r.abort());
        await p.evaluateOnNewDocument((prompt) => {
            const fail = new URLSearchParams(location.search).get('prompt') === 'fail';
            window.__msgs = [];
            window.browser = { runtime: { id: 'x', onMessage: { addListener() {} }, sendMessage: m => {
                window.__msgs.push(m);
                if (m.action !== 'readPrompt') return Promise.resolve({});
                return Promise.resolve(fail
                    ? { ok: false, error: 'no prompt file at /x.md' }
                    : { ok: true, text: prompt, path: '/x.md' });
            } } };
        }, PROMPT);
        await p.goto(`https://www.youtube.com/watch?v=AAA&${query}`);
        for (const f of ['lib.js', 'ask-ai.js']) {
            await p.addScriptTag({ content: fs.readFileSync(path.join(ROOT, f), 'utf8') });
        }
        await p.evaluate(() => AskAi.init());
        await p.waitForSelector('#sekhmet-ask-ai', { timeout: 5000 });
        if (query.includes('open=1')) await sleep(500);
        await p.click('#sekhmet-ask-ai');
        await sleep(4500);
        const state = await p.evaluate(() => ({
            fake: window.__fake,
            msgs: window.__msgs,
            toast: [...document.querySelectorAll('#sekhmet-toast-container > *')].map(t => t.textContent).join(' | '),
        }));
        await shot(p, `ask-ai-${query.replace(/[^a-z0-9]+/gi, '-')}`);
        await p.close();
        return { ...state, pageErrors };
    }

    let s = await scenario('ask=tagged');
    check('tagged: prompt name sent to background', s.msgs.some(m => m.action === 'readPrompt' && m.name === 'summarize-video-public'), s.msgs);
    check('tagged: entry button clicked once', s.fake.entryClicks === 1, s.fake.entryClicks);
    check('tagged: whole prompt sent once, after loading', s.fake.sent.length === 1 && s.fake.sent[0] === PROMPT, s.fake.sent);
    check('tagged: success toast', /Asked for a summary/.test(s.toast), s.toast);
    check('tagged: no page errors', s.pageErrors.length === 0, s.pageErrors);

    s = await scenario('ask=labelled');
    check('labelled fallback: prompt sent', s.fake.sent.length === 1 && s.fake.sent[0] === PROMPT, s.fake.sent);

    s = await scenario('ask=tagged&open=1');
    check('already open: entry button not clicked (it would close the panel)', s.fake.entryClicks === 0, s.fake.entryClicks);
    check('already open: prompt sent', s.fake.sent.length === 1 && s.fake.sent[0] === PROMPT, s.fake.sent);

    s = await scenario('ask=none');
    check('no Ask button: error toast', /Could not find YouTube's Ask button/.test(s.toast), s.toast);
    check('no Ask button: nothing sent', s.fake.sent.length === 0, s.fake.sent);

    s = await scenario('ask=tagged&prompt=fail');
    check('prompt unreadable: error toast with reason', /Could not read the summary prompt/.test(s.toast) && /no prompt file/.test(s.toast), s.toast);
    check('prompt unreadable: panel not opened', s.fake.entryClicks === 0, s.fake.entryClicks);
}));
