// Static checks that do not need a page: every .js parses, and every file the
// manifest names exists. The second one is why the extension refused to load at
// all once - a script referenced by manifest.json that was not on disk.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let problems = 0;

const sources = fs.readdirSync(ROOT).filter(f => f.endsWith('.js'))
    .map(f => f)
    .concat(fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.js'))
        .map(f => path.join('test', f)));

for (const rel of sources) {
    try {
        new vm.Script(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel });
    } catch (e) {
        console.log(`  SYNTAX  ${rel}: ${e.message}`);
        problems++;
    }
}
console.log(`  ${sources.length} files parse`);

// No extension script may call tabs.reload: refreshing every matching tab woke
// about 1,290 sleeping tabs at once and ran Brave out of memory three times.
// Comments are left out, so a note about the old code does not trip it.
const reloaders = sources.filter(rel => !rel.startsWith('test' + path.sep)).filter(rel => {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
    return /\btabs\s*\.\s*reload\b/.test(code);
});
if (reloaders.length) {
    console.log(`  TABS.RELOAD  ${reloaders.join(', ')}: do not reload tabs from the extension (CLAUDE.md, "Reload Sekhmet no other way"); ask the user first`);
    problems += reloaders.length;
} else {
    console.log('  no extension script calls tabs.reload');
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const referenced = [
    ...(manifest.background ? manifest.background.scripts : []),
    ...manifest.content_scripts.flatMap(cs => [...(cs.js || []), ...(cs.css || [])]),
    ...(manifest.web_accessible_resources || [])
];
const missing = [...new Set(referenced)].filter(f => !fs.existsSync(path.join(ROOT, f)));

if (missing.length) {
    console.log(`  MISSING  manifest names files that do not exist: ${missing.join(', ')}`);
    problems += missing.length;
} else {
    console.log(`  all ${new Set(referenced).size} manifest files present`);
}

process.exit(problems ? 1 : 0);
