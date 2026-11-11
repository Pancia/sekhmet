// Reloads the extension on request, for an unpacked install only - a packaged
// one never runs any of this. The request comes from native-host/
// reload-extension, through a native host that sits blocked on a pipe until
// then: nothing here polls. (It used to: fetching every file once a second to
// spot changes is what first ate Brave's memory, and why this is push now.)
//
// It refreshes no tab. A reload leaves the scripts in open tabs cut off from
// the extension, and each loaded tab then offers to reload itself (lib.js,
// watchForExtensionReload) - the same as after the Reload button on
// brave://extensions. An earlier version refreshed every tab that used a
// changed file. With about 1,290 such tabs open, nearly all asleep, that loaded
// them all at once: the memory runaway of 2026-10-22 to 2026-11-11.
(function() {
    const HOST = 'com.sekhmet.dev_reload';
    // The earlier version's list of tabs to refresh, kept across the reload.
    // Nothing reads it now. It is removed so that no later code ever can.
    const OLD_PENDING_KEY = 'sekhmet_devReloadTabs';

    async function listen() {
        const self = await browser.management.getSelf();
        if (self.installType !== 'development') { return; }

        await browser.storage.local.remove(OLD_PENDING_KEY);

        const port = browser.runtime.connectNative(HOST);
        port.onMessage.addListener(msg => {
            if (!msg || !msg.reload) { return; }
            const changed = msg.files || [];
            console.log(`Sekhmet: dev reload - requested${changed.length ? ': ' + changed.join(', ') : ''}`);
            browser.runtime.reload();
        });
        // Once, and no retry: a missing host means install.sh has not been run,
        // and trying again on a timer is the polling this replaced.
        port.onDisconnect.addListener(p => {
            const err = (p && p.error) || (typeof chrome !== 'undefined' && chrome.runtime.lastError);
            console.log('Sekhmet: dev reload host disconnected', err ? err.message : '');
        });
        console.log('Sekhmet: dev reload - listening');
    }

    listen().catch(err => console.error('Sekhmet: dev reload failed to start', err));
})();
