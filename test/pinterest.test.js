// Tests for the two decisions in pinterest.js: when a pin counts as wholly on
// screen, which is when its veil comes off for good, and which pins are veiled. The rest runs against
// Pinterest's live DOM; .cc/scripts/pinterest-e2e.js drives that in a real
// browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { group, ok, done } = require('./assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'pinterest.js'), 'utf8')
    .replace(/\nPinterestPeek\.init\(\);\s*$/, '\n');
const { reveals, veils } = vm.runInNewContext(src + '\nPinterestPeek', {
    initLogger: () => ({ log() {}, debug() {}, error() {} })
});

const V = 900;

group('a pin is revealed once it is wholly on screen');
{
    ok('wholly on screen', reveals(400, 800, V, false) === true);
    ok('ending exactly at the bottom edge', reveals(500, 900, V, false) === true);
    ok('starting exactly at the top edge', reveals(0, 400, V, false) === true);
}

group('a pin not wholly on screen stays veiled');
{
    ok('cut off by the bottom edge', reveals(700, 1000, V, false) === false);
    ok('one pixel in', reveals(899, 1200, V, false) === false);
    ok('not reached yet', reveals(950, 1300, V, false) === false);
    ok('cut off by the top edge', reveals(-200, 300, V, false) === false);
}

group('pins that could never be whole are shown at once');
{
    ok('taller than most of the window', reveals(500, 500 + V, V, false) === true);
    ok('a wide item (the opened pin on its own page)', reveals(700, 1000, V, true) === true);
}

group('a pin is veiled until it has been revealed');
{
    ok('not revealed yet', veils('pin:1', new Set()) === true);
    ok('revealed', veils('pin:1', new Set(['pin:1'])) === false);
    ok('another pin revealed', veils('pin:1', new Set(['pin:2'])) === true);
}

group('an item with no key is never veiled');
{
    // No pin link and no picture: it can never be revealed, and a veiled
    // item takes no clicks, so veiling it would leave it dead for good.
    ok('null key', veils(null, new Set()) === false);
    ok('null key, others revealed', veils(null, new Set(['pin:1'])) === false);
}

done();
