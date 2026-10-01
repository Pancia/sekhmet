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

async function renderSlot(slot, label, list) {
    const status = el('div', { className: 'status' });
    const grid = el('div', { className: 'grid' });

    for (const entry of list) {
        const tile = el('div', { className: 'tile', title: entry.name });
        const data = await Wallpapers.image(entry.id);
        if (data) { tile.style.backgroundImage = `url("${data}")`; }
        const remove = el('button', { type: 'button', textContent: '×', title: `Remove ${entry.name}` });
        remove.addEventListener('click', async () => {
            await Wallpapers.remove(slot, entry.id);
            render();
        });
        tile.append(remove);
        grid.append(tile);
    }

    const input = el('input', { type: 'file', accept: 'image/*', multiple: true });
    const add = el('label', { className: 'add' }, 'Add images', input);
    const addFiles = async files => {
        const images = Array.from(files).filter(f => f.type.startsWith('image/'));
        for (let i = 0; i < images.length; i++) {
            status.textContent = `Adding ${i + 1} of ${images.length}…`;
            try {
                await Wallpapers.add(slot, await shrink(images[i]));
            } catch (e) {
                status.textContent = `Could not add ${images[i].name}: ${e.message}`;
                return;
            }
        }
        render();
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
