// Behaviour for openfront-blocked.html. This is an extension page, not a
// content script, so it has the full browser.* API and no page CSP to fight.
(function () {
    const prefix = "[YT+] [openfront]:";
    const SINCE_KEY = "openfrontBlockedSince";

    document.getElementById("sekhmet-close").addEventListener("click", () => {
        // window.close() is ignored for tabs the page didn't open, so remove
        // the tab by id instead.
        browser.tabs.getCurrent()
            .then(tab => browser.tabs.remove(tab.id))
            .catch(err => console.error(prefix, "could not close tab", err));
    });

    // Stamp the first block as day zero, then quietly count up from there.
    const today = new Date().toISOString().slice(0, 10);
    browser.storage.local.get(SINCE_KEY).then(stored => {
        let since = stored[SINCE_KEY];
        if (!since) {
            since = today;
            browser.storage.local.set({ [SINCE_KEY]: since });
        }
        const days = Math.max(
            0,
            Math.round((Date.parse(today) - Date.parse(since)) / 86400000)
        );
        if (days < 1) return;

        const el = document.getElementById("sekhmet-since");
        el.textContent = " You've held this for ";
        const count = document.createElement("span");
        count.className = "since";
        count.textContent = `${days} day${days === 1 ? "" : "s"}`;
        el.append(count, ".");
    }).catch(err => console.error(prefix, "could not read block date", err));
})();
