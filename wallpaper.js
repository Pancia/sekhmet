// Fills the frame with one of the slot's wallpapers, or leaves it transparent - and the
// gate's own near-black showing - when the user has added none.
(async function() {
    const params = new URLSearchParams(location.search);
    const slot = params.get('slot');
    const seed = parseFloat(params.get('seed'));

    let chosen = null;
    try { chosen = await Wallpapers.pick(slot, isNaN(seed) ? undefined : seed); } catch (e) { return; }
    if (!chosen) { return; }

    // Cover unless the shapes are far apart - a portrait picture on a landscape
    // gate would be cropped down to a strip, so show it whole instead.
    const fit = () => {
        const image = chosen.width / chosen.height;
        const frame = window.innerWidth / Math.max(window.innerHeight, 1);
        const ratio = image / frame;
        document.body.style.backgroundSize = (ratio < 0.6 || ratio > 1 / 0.6) ? 'contain' : 'cover';
    };

    document.body.style.backgroundColor = '#000';
    document.body.style.backgroundImage = `url("${chosen.dataUrl}")`;
    fit();
    window.addEventListener('resize', fit);
    document.body.style.opacity = '1';
})();

