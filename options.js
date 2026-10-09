// Options page: add and remove gate wallpapers per slot.

// Big enough for a 1440p screen, small enough that a folder of them does not turn
// extension storage into a photo library - a 5K PNG comes out around 500KB.
const MAX_EDGE = 2560;
const QUALITY = 0.85;

function readAsImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name} is not an image`)); };
        img.src = url;
    });
}

async function shrink(file) {
    const img = await readAsImage(file);
    // An SVG with no intrinsic size decodes as 0x0 and would store an empty image.
    if (!img.naturalWidth || !img.naturalHeight) {
        throw new Error('it has no size (an SVG without width/height?)');
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.round(img.naturalWidth * scale);
    const height = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return { name: file.name, width, height, dataUrl: canvas.toDataURL('image/jpeg', QUALITY) };
}

function el(tag, props, ...children) {
    const node = Object.assign(document.createElement(tag), props || {});
    children.forEach(c => node.append(c));
    return node;
}

// A message to show in a slot's status line on its next render, then forget.
const notices = {};

async function renderSlot(slot, label, list) {
    const status = el('div', { className: 'status', textContent: notices[slot] || '' });
    delete notices[slot];
    const grid = el('div', { className: 'grid' });

    for (const entry of list) {
        const tile = el('div', { className: 'tile', title: entry.name });
        const data = await Wallpapers.image(entry.id);
        if (data) { tile.style.backgroundImage = `url("${data}")`; }
        const remove = el('button', { type: 'button', textContent: '×', title: `Remove ${entry.name}` });
        remove.addEventListener('click', async () => {
            try {
                await Wallpapers.remove(slot, entry.id);
                render();
            } catch (e) {
                status.textContent = `Could not remove ${entry.name}: ${e.message}`;
            }
        });
        tile.append(remove);
        grid.append(tile);
    }

    const input = el('input', { type: 'file', accept: 'image/*', multiple: true });
    const add = el('label', { className: 'add' }, 'Add images', input);
    // One bad file is skipped, not fatal: the rest still go in, and the page is
    // redrawn either way so whatever did land shows up. The error message is
    // carried across the redraw, which replaces this section.
    const addFiles = async files => {
        const images = Array.from(files).filter(f => f.type.startsWith('image/'));
        const failed = [];
        for (let i = 0; i < images.length; i++) {
            status.textContent = `Adding ${i + 1} of ${images.length}…`;
            try {
                await Wallpapers.add(slot, await shrink(images[i]));
            } catch (e) {
                failed.push(`${images[i].name}: ${e.message}`);
            }
        }
        // Cleared so picking the same file again still fires change.
        input.value = '';
        if (failed.length) { notices[slot] = `Could not add ${failed.join('; ')}`; }
        await render();
    };
    input.addEventListener('change', () => addFiles(input.files));
    add.addEventListener('dragover', e => { e.preventDefault(); add.classList.add('dragging'); });
    add.addEventListener('dragleave', () => add.classList.remove('dragging'));
    add.addEventListener('drop', e => {
        e.preventDefault();
        add.classList.remove('dragging');
        addFiles(e.dataTransfer.files);
    });
    grid.append(add);

    const count = el('span', {
        className: 'count',
        textContent: list.length === 1 ? '1 image' : `${list.length} images`
    });
    return el('section', {},
        el('header', {}, el('h2', { textContent: label }), count),
        grid,
        status);
}

async function render() {
    const idx = await Wallpapers.index();
    const sections = [];
    for (const [slot, label] of Object.entries(Wallpapers.SLOTS)) {
        sections.push(await renderSlot(slot, label, idx[slot]));
    }
    document.getElementById('slots').replaceChildren(...sections);
}

render();
