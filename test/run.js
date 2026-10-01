// Runs every *.test.js in this directory, each in its own process so one
// module's globals cannot bleed into the next.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let failed = [];

for (const f of files) {
    console.log(`\n${'='.repeat(60)}\n${f}\n${'='.repeat(60)}`);
    try {
        console.log(execFileSync(process.execPath, [path.join(__dirname, f)], {
            encoding: 'utf8'
        }).trim());
    } catch (e) {
        console.log((e.stdout || '').trim());
        if (e.stderr) console.error(e.stderr.trim());
        failed.push(f);
    }
}

console.log(`\n${'='.repeat(60)}`);
if (failed.length) {
    console.log(`FAILED: ${failed.join(', ')}`);
    process.exit(1);
}
console.log(`${files.length} suites passed`);
