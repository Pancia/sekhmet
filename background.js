function onCreated() {
    if (browser.runtime.lastError) {
        console.error(`Sekhmet: Error: ${browser.runtime.lastError}`);
    } else {
        console.log("Sekhmet: Item created successfully");
    }
}

console.log("Sekhmet: create menu", browser.contextMenus)

browser.contextMenus.create({
    id: "sekhmet-is-enabled",
    title: "Toggle Feeling Tracker",
    contexts: ["all"],
}, onCreated);

browser.contextMenus.create({
    id: "sekhmet-debug-separator",
    type: "separator",
    contexts: ["all"],
}, onCreated);

browser.contextMenus.create({
    id: "feeling-tracker",
    title: "DEBUG: feeling tracker",
    contexts: ["all"],
}, onCreated);

browser.contextMenus.create({
    id: "color-test",
    title: "DEBUG: color test",
    contexts: ["all"],
}, onCreated);

function getCurrentTab() {
    return browser.tabs.query({ currentWindow: true, active: true });
}

// Tabs with no content script (or a discarded one) reject with "Could not
// establish connection", so every send needs a catch or it surfaces as an
// unhandled rejection in the background console on each click.
function sendToTab(tabId, trigger) {
    return browser.tabs.sendMessage(tabId, { trigger })
        .catch(err => console.log(`Sekhmet: Could not send ${trigger} to tab ${tabId}`, err));
}

async function showFeelingTracker() {
    console.log("Sekhmet: showFeelingTracker")
    const tabInfo = await getCurrentTab();
    const [{ id: tabId }] = tabInfo;
    sendToTab(tabId, 'showFeelingTrackerDialog');
}

async function toggleFeelingTracker() {
    console.log("Sekhmet: toggleFeelingTracker")
    const tabInfo = await getCurrentTab();
    const [{ id: tabId }] = tabInfo;
    sendToTab(tabId, 'toggleFeelingTracker');
}

// Update context menu title with current status before it shows.
// The enable flag is per-tab and lives in that tab's sessionStorage, so we ask
// the content script rather than reading storage.local here.
async function updateMenuStatus() {
    const generic = { title: "Toggle Feeling Tracker" };
    try {
        const tabInfo = await getCurrentTab();
        const [{ id: tabId, url }] = tabInfo;

        // onShown fires for every context menu on every site, so skip the
        // round trip entirely off YouTube rather than messaging a tab with no
        // content script and logging the rejection each time.
        if (!url || !/^https?:\/\/([^/]*\.)?youtube\.com\//.test(url)) {
            return browser.contextMenus.update("sekhmet-is-enabled", generic);
        }

        const response = await browser.tabs.sendMessage(tabId, { trigger: 'getFeelingTrackerState' });
        // A tab with a receiver but no handler for this trigger resolves with
        // undefined, so check for the boolean instead of treating "not false"
        // as enabled — otherwise a tab with no tracker reports "✅ Enabled".
        if (!response || typeof response.enabled !== 'boolean') {
            return browser.contextMenus.update("sekhmet-is-enabled", generic);
        }

        return browser.contextMenus.update("sekhmet-is-enabled", {
            title: `Feeling Tracker: ${response.enabled ? "✅ Enabled" : "❌ Disabled"} (click to toggle)`,
        });
    } catch (err) {
        // No content script in this tab yet, or it is discarded.
        console.log("Sekhmet: Could not update menu status", err);
        return browser.contextMenus.update("sekhmet-is-enabled", generic);
    }
}

// Update status when context menu is shown (Firefox)
if (browser.contextMenus.onShown) {
    browser.contextMenus.onShown.addListener(() => {
        // updateMenuStatus resolves only once contextMenus.update has settled,
        // so refresh() can't race ahead of the title it is meant to show.
        updateMenuStatus()
            .then(() => browser.contextMenus.refresh())
            .catch(err => console.log("Sekhmet: Could not refresh menu", err));
    });
}

browser.contextMenus.onClicked.addListener((info, tab) => {
    console.log("Sekhmet: menu listener")
    switch (info.menuItemId) {
        case "feeling-tracker":
            showFeelingTracker();
            break;
        case "color-test":
            getCurrentTab().then(([{ id: tabId }]) => sendToTab(tabId, 'showColorTest'));
            break;
        case "sekhmet-is-enabled":
            toggleFeelingTracker();
            // Update menu title after toggle. updateMenuStatus returns the
            // contextMenus.update promise rather than awaiting it, so its own
            // try/catch doesn't cover a rejecting update — this call site needs
            // its own catch or that surfaces as an unhandled rejection.
            setTimeout(() => {
                updateMenuStatus().catch(err => console.log("Sekhmet: Could not update menu status", err));
            }, 500);
            break;
    }
});

// Handle message for getting tab ID
// Only async branches that reply later return `true` (keep the channel open).
// Synchronous / fire-and-forget branches must return undefined.
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case "getTabId":
            console.log("Sekhmet: Tab ID requested", sender.tab.id);
            sendResponse({ tabId: sender.tab.id }); // synchronous reply
            return;

        case "openfrontBlocked":
            // Unreachable while openfront-block.js is out of the manifest; see
            // the note at the top of that file. The content script has already
            // stopped the load; swap the tab over to the reminder page, which
            // renders as a normal document.
            if (sender.tab) {
                browser.tabs.update(sender.tab.id, {
                    url: browser.runtime.getURL("openfront-blocked.html"),
                }).catch(err => console.error("Sekhmet: Could not reroute openfront tab", err));
            }
            return;

        case "saveFile":
            // Fire-and-forget. Relies on the persistent MV2 background page staying
            // alive until the native host replies; would need rework under MV3.
            browser.runtime.sendNativeMessage(
                "com.sekhmet.feeling_tracker",
                JSON.parse(request.content)
            ).then(response => {
                console.log("Sekhmet: Native host response", response);
            }).catch(err => {
                console.error("Sekhmet: Native messaging failed", err);
            });
            return;

        case "ytdlDownload":
            browser.runtime.sendNativeMessage("com.sekhmet.ytdl", {
                id: request.id,
                videoType: request.videoType,
                downloadType: request.downloadType,
                quality: request.quality,
            }).then(response => {
                console.log("Sekhmet: ytdl host response", response);
                sendResponse(response);
            }).catch(err => {
                console.error("Sekhmet: ytdl native messaging failed", err);
                sendResponse({ ok: false, error: String(err) });
            });
            return true; // keep the channel open for the async sendResponse
    }
});
