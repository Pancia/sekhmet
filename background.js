function onCreated() {
    if (browser.runtime.lastError) {
        console.error(`YTF: Error: ${browser.runtime.lastError}`);
    } else {
        console.log("YTF: Item created successfully");
    }
}

console.log("YTF: create menu", browser.menus)
browser.menus.create({
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

browser.menus.onClicked.addListener((info, tab) => {
    console.log("YTF: menu listener")
    switch (info.menuItemId) {
        case "feeling-tracker":
            showFeelingTracker();
            break;
    }
});
