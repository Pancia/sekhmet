function onCreated() {
    if (browser.runtime.lastError) {
        console.error(`YTF: Error: ${browser.runtime.lastError}`);
    } else {
        console.log("YTF: Item created successfully");
    }
}

console.log("YTF: create menu", browser.contextMenus)
browser.contextMenus.create({
    id: "feeling-tracker",
    title: "DEBUG: feeling tracker",
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

browser.contextMenus.onClicked.addListener((info, tab) => {
    console.log("YTF: menu listener")
    switch (info.menuItemId) {
        case "feeling-tracker":
            showFeelingTracker();
            break;
        case "ytf-is-enabled":
            toggleFeelingTracker();
            break;
    }
});

browser.contextMenus.create({
    id: "ytf-is-enabled",
    title: "Toggle Feeling Tracker",
    contexts: ["all"],
}, onCreated);

// Handle message for getting tab ID
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getTabId") {
        console.log("YTF: Tab ID requested", sender.tab.id);
        sendResponse({ tabId: sender.tab.id });
        return true; // Indicates we'll respond asynchronously
    }
});
