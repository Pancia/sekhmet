// ✨ in the masthead pill (greyed out off watch pages): opens YouTube's own "Ask" panel for the current
// video and sends it a prompt kept on this machine, outside the repo.
//
// The prompt is ~/dotfiles/ai/prompts/<ASK_AI_PROMPT>.md. The extension cannot
// read local files, so the background page asks the com.sekhmet.prompts native
// host for it (native-host/prompts_host.py). It is read on every click, so an
// edit to the file needs no extension reload.
//
// Ask only exists when signed in, so the selectors below come from YouTube's
// own bundle rather than a probed page:
//   - the panel is the engagement panel with target-id "PAyouchat" (youtube.js
//     already styles it);
//   - its input is a <textarea> inside <yt-chat-input-view-model>, and the
//     form's send button is disabled while a reply is still loading;
//   - the entry button's <button-view-model> carries the class
//     "you-chat-entrypoint-button". A button labelled "Ask" under the video is
//     the fallback.
// Each watch page and each click log one [ask-ai] line with what matched.
const AskAi = (function () {
    const { log, error } = initLogger("ask-ai");

    const ASK_AI_PROMPT = "summarize-video-public";
    const BUTTON_ID = "sekhmet-ask-ai";
    const PANEL = 'ytd-engagement-panel-section-list-renderer[target-id="PAyouchat"]';
    const INPUT = `${PANEL} yt-chat-input-view-model textarea`;
    const SEND = `${PANEL} yt-chat-input-view-model form button`;
    const PROMPT_TIMEOUT_MS = 8000;
    const PANEL_TIMEOUT_MS = 10000;
    const READY_TIMEOUT_MS = 20000;

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const visible = el => !!el && el.getClientRects().length > 0;

    function isWatchPage() {
        return window.location.hostname === "www.youtube.com" && window.location.pathname === "/watch";
    }

    async function waitFor(fn, timeoutMs, stepMs = 200) {
        const end = Date.now() + timeoutMs;
        for (;;) {
            const v = fn();
            if (v) return v;
            if (Date.now() >= end) return null;
            await sleep(stepMs);
        }
    }

    function findAskButtons() {
        const tagged = [...document.querySelectorAll("button-view-model.you-chat-entrypoint-button button")]
            .filter(visible);
        const labelled = [...document.querySelectorAll("ytd-watch-flexy button")]
            .filter(b => b.id !== BUTTON_ID && visible(b) && !tagged.includes(b))
            .filter(b => {
                const label = (b.getAttribute("aria-label") || b.textContent || "").trim();
                return /^ask\b/i.test(label);
            });
        return { tagged, labelled, best: tagged[0] || labelled[0] || null };
    }

    function panelOpen() {
        const panel = document.querySelector(PANEL);
        return !!panel && panel.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
    }

    const visibleInput = () => [...document.querySelectorAll(INPUT)].find(visible) || null;
    const visibleSend = () => [...document.querySelectorAll(SEND)].find(visible) || null;
    const isDisabled = b => b.disabled || b.getAttribute("aria-disabled") === "true";

    function readPrompt() {
        return Promise.race([
            browser.runtime.sendMessage({ action: "readPrompt", name: ASK_AI_PROMPT }),
            sleep(PROMPT_TIMEOUT_MS).then(() => ({
                ok: false,
                error: "The background page never replied.",
            })),
        ]).catch(err => ({ ok: false, error: String(err && err.message || err) }));
    }

    // The textarea's own handlers read .value on keyup and Enter, so setting
    // the value and firing the events it listens for is enough.
    function fill(textarea, text) {
        textarea.focus();
        textarea.value = text;
        textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true, composed: true }));
    }

    function pressEnter(textarea) {
        textarea.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter", code: "Enter", keyCode: 13, which: 13,
            bubbles: true, cancelable: true, composed: true,
        }));
    }

    let busy = false;

    async function run() {
        if (busy) return;
        busy = true;
        const toast = showToast("Reading the summary prompt…", { status: "pending", timeout: 0 });
        const fail = (text, detail) => {
            toast.update(text, { status: "error", detail, timeout: 10000 });
        };
        try {
            if (!isWatchPage()) {
                fail("Open a video first");
                return;
            }

            const prompt = await readPrompt();
            if (!prompt || prompt.ok !== true) {
                log(`click: prompt not read: ${prompt && prompt.error}`);
                fail("Could not read the summary prompt", prompt && prompt.error);
                return;
            }

            const wasOpen = panelOpen();
            const buttons = findAskButtons();
            log(`click: panel open=${wasOpen}, Ask buttons tagged=${buttons.tagged.length} labelled=${buttons.labelled.length}, prompt ${prompt.text.length} chars`);

            if (!wasOpen) {
                if (!buttons.best) {
                    fail("Could not find YouTube's Ask button",
                        "It may be in the ⋯ menu under the video, or Ask is not offered for this video.");
                    return;
                }
                toast.update("Opening Ask…", { status: "pending", timeout: 0 });
                buttons.best.click();
            }

            const textarea = await waitFor(visibleInput, PANEL_TIMEOUT_MS);
            if (!textarea) {
                log(`click: no input after ${PANEL_TIMEOUT_MS / 1000}s (panel nodes=${document.querySelectorAll(PANEL).length})`);
                fail("The Ask panel did not show its text box");
                return;
            }

            fill(textarea, prompt.text);
            if (textarea.value !== prompt.text) {
                log(`click: text box kept ${textarea.value.length} of ${prompt.text.length} chars`);
            }

            // The panel loads a welcome message when it opens, and the send
            // button stays disabled until that finishes.
            toast.update("Waiting for Ask…", { status: "pending", timeout: 0 });
            const send = await waitFor(() => {
                const b = visibleSend();
                return b && !isDisabled(b) ? b : null;
            }, READY_TIMEOUT_MS);
            if (send) {
                send.click();
            } else {
                log(`click: send button ${visibleSend() ? "still disabled" : "not found"}, pressing Enter`);
                pressEnter(textarea);
            }

            const sent = await waitFor(() => textarea.value.length === 0, 3000);
            log(`click: sent via ${send ? "send button" : "Enter"}, text box cleared=${!!sent}`);
            if (sent) {
                toast.update("Asked for a summary", { status: "ok", timeout: 4000 });
            } else {
                fail("Ask did not take the prompt",
                    "The prompt is in the text box. Press Enter in the panel to send it.");
            }
        } catch (err) {
            error("click failed", err);
            fail("Ask failed", String(err));
        } finally {
            busy = false;
        }
    }

    // Off watch pages the button stays in its slot, greyed out like a
    // placeholder, so the pill keeps its shape across navigation.
    function updateVisibility() {
        const btn = document.getElementById(BUTTON_ID);
        if (!btn) return;
        const on = isWatchPage();
        btn.style.opacity = on ? "" : "0.35";
        btn.style.filter = on ? "" : "grayscale(1)";
        btn.style.cursor = on ? "pointer" : "default";
        btn.style.pointerEvents = on ? "" : "none";
        btn.title = on ? "Summarize this video in YouTube's Ask panel" : "Open a video to summarize it";
    }

    function addButton() {
        if (document.getElementById(BUTTON_ID)) return;
        const btn = document.createElement("a");
        btn.id = BUTTON_ID;
        btn.textContent = "✨";
        btn.style.fontSize = "28px";
        btn.style.lineHeight = "1";
        btn.style.userSelect = "none";
        btn.addEventListener("click", run);
        if (fillMastheadSlot("ask", btn)) updateVisibility();
    }

    // One line per watch page, a few seconds in, so a report of "it does
    // nothing" comes with what the page offered.
    let reportTimer = null;
    function reportPage() {
        clearTimeout(reportTimer);
        if (!isWatchPage()) return;
        const videoId = new URLSearchParams(window.location.search).get("v");
        reportTimer = setTimeout(() => {
            if (!isWatchPage()) return;
            const b = findAskButtons();
            log(`page ${videoId}: Ask buttons tagged=${b.tagged.length} labelled=${b.labelled.length}, panel nodes=${document.querySelectorAll(PANEL).length}`);
        }, 4000);
    }

    function init() {
        if (window.location.hostname !== "www.youtube.com") return;
        waitForElementToBeLoaded("#center.ytd-masthead", addButton);
        document.addEventListener("yt-navigate-finish", () => {
            // The masthead can be rebuilt, taking the pill and the button with it.
            if (!document.getElementById(BUTTON_ID)) addButton();
            updateVisibility();
            reportPage();
        });
        reportPage();
    }

    return { init, run };
})();
