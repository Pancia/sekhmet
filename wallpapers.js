// Gate wallpapers: chosen per user on the options page, kept in extension storage,
// never shipped in the repo.
//
// Shared by options.js (writes) and wallpaper.js (reads). The index and the image
// data live under separate keys so adding or removing one picture never rewrites
// the others - each is a data URL of a few hundred KB.
const Wallpapers = (function() {
    const INDEX_KEY = 'sekhmet_wallpapers';
    const imageKey = id => `sekhmet_wallpaper:${id}`;

    // One list per gate. The key is what a gate names in its overlay config.
    const SLOTS = {
        youtube: 'YouTube player',
        openfront: 'openfront.io'
    };

    async function index() {
        const got = await browser.storage.local.get(INDEX_KEY);
        const idx = got[INDEX_KEY] || {};
        Object.keys(SLOTS).forEach(slot => { idx[slot] = idx[slot] || []; });
        return idx;
    }

    // add and remove are read-modify-write on one index key, so two in flight - a
    // quick double removal, files dropped on two slots at once - would each write
    // back a copy missing the other's change. They queue behind one another.
    let queue = Promise.resolve();
    const serial = fn => (...args) => {
        const run = queue.then(() => fn(...args));
        queue = run.catch(() => {});
        return run;
    };

    const add = serial(async function(slot, { name, width, height, dataUrl }) {
        const idx = await index();
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        await browser.storage.local.set({ [imageKey(id)]: dataUrl });
        idx[slot].push({ id, name, width, height });
        await browser.storage.local.set({ [INDEX_KEY]: idx });
        return id;
    });

    const remove = serial(async function(slot, id) {
        const idx = await index();
        idx[slot] = idx[slot].filter(w => w.id !== id);
        await browser.storage.local.set({ [INDEX_KEY]: idx });
        await browser.storage.local.remove(imageKey(id));
    });

    async function image(id) {
        const got = await browser.storage.local.get(imageKey(id));
        return got[imageKey(id)] || null;
    }

    // One at random, so the same gate can come up different each time. seed, a
    // number in [0, 1), makes the pick repeatable: a frame that reloads - YouTube
    // reaps the gate and it is put back - must land on the same picture, not flash
    // to a new one.
    async function pick(slot, seed = Math.random()) {
        const list = (await index())[slot] || [];
        // Start at the seeded entry and walk on past any whose picture is missing,
        // so one broken entry never turns the gate black while others exist.
        const start = Math.floor(seed * list.length) % Math.max(list.length, 1);
        for (let i = 0; i < list.length; i++) {
            const entry = list[(start + i) % list.length];
            const dataUrl = await image(entry.id);
            if (dataUrl) { return Object.assign({ dataUrl }, entry); }
        }
        return null;
    }

    return { SLOTS, index, add, remove, image, pick };
})();
