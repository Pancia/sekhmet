// Tests for the overlay gates in overlays.js.
//
// overlays.js is a single IIFE that reaches for the DOM as soon as it is
// evaluated, and the decisions worth testing here are pure. So rather than stub a
// page, each function is lifted out of the source by name and evaluated against
// the state it reads. That keeps these honest - a rename or a reshape fails loudly
// instead of silently testing a stale copy.
const fs = require('fs');
const path = require('path');
const { group, ok, done } = require('./assert');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'overlays.js'), 'utf8');

function lift(name) {
    const i = src.indexOf(`    function ${name}(`);
    if (i < 0) throw new Error(`${name}() not found — overlays.js changed shape`);
    const end = src.indexOf('\n    }\n', i);
    if (end < 0) throw new Error(`${name}() has no closing brace at the expected indent`);
    return src.slice(i, end + 6);
}

const MIN = 60 * 1000;
const GATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const clearedGates = new Map();
const log = () => {};
eval(lift('gateTtl') + '\n' + lift('gateStillCleared'));

// The openfront config's own values, read out of the file rather than restated.
const cfg = src.slice(src.indexOf('const OPENFRONT_OVERLAY'), src.indexOf('const OVERLAY_CONFIG'));
const OPENFRONT = {
    clearedTtlMs:    eval(cfg.match(/clearedTtlMs:\s*([^,]+),/)[1]),
    pathPattern:     eval(cfg.match(/pathPattern:\s*(\/.*?\/),/)[1]),
    rememberCleared: eval(cfg.match(/rememberCleared:\s*(\w+),/)[1]),
    holdTime:        eval(cfg.match(/holdTime:\s*(\d+)/)[1])
};

group('the openfront gate is configured as intended');
ok('cooldown is 5 minutes',   OPENFRONT.clearedTtlMs === 5 * MIN);
ok('the clear is persisted',  OPENFRONT.rememberCleared === true);
ok('the hold is still 15s',   OPENFRONT.holdTime === 15000);

group('root page only');
ok('gates openfront.io/',              OPENFRONT.pathPattern.test('/'));
ok('ignores /join/ABCD',              !OPENFRONT.pathPattern.test('/join/ABCD'));
ok('ignores /leaderboard',            !OPENFRONT.pathPattern.test('/leaderboard'));
ok('anchored, not a substring match', !OPENFRONT.pathPattern.test('/a/'));

group('the five-minute cooldown');
clearedGates.clear();
ok('no entry at all -> the gate shows', gateStillCleared('openfront', OPENFRONT) === false);
clearedGates.set('openfront', Date.now());
ok('just cleared -> stays down',        gateStillCleared('openfront', OPENFRONT) === true);
clearedGates.set('openfront', Date.now() - 4.9 * MIN);
ok('4m54s ago -> still down',           gateStillCleared('openfront', OPENFRONT) === true);
clearedGates.set('openfront', Date.now() - 5.1 * MIN);
ok('5m06s ago -> the gate returns',     gateStillCleared('openfront', OPENFRONT) === false);
ok('the expired entry is dropped',      !clearedGates.has('openfront'));

group('the youtube gates keep their month');
clearedGates.set('vid123', Date.now() - 10 * 24 * 60 * MIN);
ok('10 days ago, no override -> still cleared', gateStillCleared('vid123', {}) === true);
clearedGates.set('vid123', Date.now() - 40 * 24 * 60 * MIN);
ok('40 days ago -> asks once more',             gateStillCleared('vid123', {}) === false);
ok('an absent config falls back to the default', gateTtl(undefined) === GATE_TTL_MS);
ok('the openfront config overrides it',          gateTtl(OPENFRONT) === 5 * MIN);

group('malformed entries');
clearedGates.set('junk', 'not-a-number');
ok('a non-numeric timestamp gates rather than throws',
    gateStillCleared('junk', OPENFRONT) === false);

group('fragment changes are not navigation');
{
    // openfront.io routes lobbies through the fragment, and MAIN() retires the
    // whole page's wiring before rebuilding it - so treating a hash change as
    // navigation drops the gate mid-hold and raises a fresh one.
    let location = {};
    eval(lift('navigationUrl'));
    const at = (pathname, search, hash) => {
        location = { pathname, search, hash };
        return navigationUrl();
    };

    ok('bare root and a lobby fragment are one page',
        at('/', '', '') === at('/', '', '#join/ABCD'));
    ok('two different fragments are still one page',
        at('/', '', '#join/ABCD') === at('/', '', '#game/999'));
    ok('the fragment never leaks into the identity',
        !at('/', '', '#join/ABCD').includes('#'));
    ok('a real path change still counts',
        at('/', '', '') !== at('/leaderboard', '', ''));
    ok("YouTube's &t= stamp still counts",
        at('/watch', '?v=A', '') !== at('/watch', '?v=A&t=30', ''));
    ok('a different video still counts',
        at('/watch', '?v=A', '') !== at('/watch', '?v=B', ''));
}

done();
