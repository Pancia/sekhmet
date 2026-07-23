function onCreated() {
    if (browser.runtime.lastError) {
        console.error(`YTF: Error: ${browser.runtime.lastError}`);
    } else {
        console.log("YTF: Item created successfully");
    }
}

console.log("YTF: create menu", browser.contextMenus)

browser.contextMenus.create({
    id: "ytf-is-enabled",
    title: "Toggle Feeling Tracker",
    contexts: ["all"],
}, onCreated);

browser.contextMenus.create({
    id: "ytf-debug-separator",
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

async function showFeelingTracker() {
    console.log("YTF: showFeelingTracker")
    const tabInfo = await getCurrentTab();
    const [{ id: tabId }] = tabInfo;
    browser.tabs.sendMessage(tabId, { trigger: 'showFeelingTrackerDialog' });
}

async function toggleFeelingTracker() {
    console.log("YTF: toggleFeelingTracker")
    const tabInfo = await getCurrentTab();
    const [{ id: tabId }] = tabInfo;
    browser.tabs.sendMessage(tabId, { trigger: 'toggleFeelingTracker' });
}

// Update context menu title with current status before it shows
async function updateMenuStatus() {
    try {
        const tabInfo = await getCurrentTab();
        const [{ id: tabId }] = tabInfo;
        const key = `ytf_feelingTracker_enabled_${tabId}`;
        const result = await browser.storage.local.get(key);
        const enabled = result[key] !== false;
        browser.contextMenus.update("ytf-is-enabled", {
            title: `Feeling Tracker: ${enabled ? "✅ Enabled" : "❌ Disabled"} (click to toggle)`,
        });
    } catch (err) {
        console.log("YTF: Could not update menu status", err);
    }
}

// Update status when context menu is shown (Firefox)
if (browser.contextMenus.onShown) {
    browser.contextMenus.onShown.addListener(() => {
        updateMenuStatus().then(() => browser.contextMenus.refresh());
    });
}

browser.contextMenus.onClicked.addListener((info, tab) => {
    console.log("YTF: menu listener")
    switch (info.menuItemId) {
        case "feeling-tracker":
            showFeelingTracker();
            break;
        case "color-test":
            getCurrentTab().then(([{ id: tabId }]) => {
                browser.tabs.sendMessage(tabId, { trigger: 'showColorTest' });
            });
            break;
        case "ytf-is-enabled":
            toggleFeelingTracker();
            // Update menu title after toggle
            setTimeout(updateMenuStatus, 500);
            break;
    }
});

// Handle message for getting tab ID
// Only async branches that reply later return `true` (keep the channel open).
// Synchronous / fire-and-forget branches must return undefined.
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case "getTabId":
            console.log("YTF: Tab ID requested", sender.tab.id);
            sendResponse({ tabId: sender.tab.id }); // synchronous reply
            return;

        case "saveFile":
            // Fire-and-forget. Relies on the persistent MV2 background page staying
            // alive until the native host replies; would need rework under MV3.
            browser.runtime.sendNativeMessage(
                "com.ytf.feeling_tracker",
                JSON.parse(request.content)
            ).then(response => {
                console.log("YTF: Native host response", response);
            }).catch(err => {
                console.error("YTF: Native messaging failed", err);
            });
            return;

        case "ytdlDownload":
            browser.runtime.sendNativeMessage("com.ytf.ytdl", {
                id: request.id,
                videoType: request.videoType,
                downloadType: request.downloadType,
                quality: request.quality,
            }).then(response => {
                console.log("YTF: ytdl host response", response);
                sendResponse(response);
            }).catch(err => {
                console.error("YTF: ytdl native messaging failed", err);
                sendResponse({ ok: false, error: String(err) });
            });
            return true; // keep the channel open for the async sendResponse
    }
});
