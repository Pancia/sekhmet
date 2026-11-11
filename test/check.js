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
