// Regression tests for loop.js.
//
// Every group below is a bug that was actually in the file. The module was lost
// to an unclean shutdown before it was ever committed and rebuilt from the
// contract its callers encode, so these exist to stop the rebuild from drifting
// back into the failures the review found.
const H = require('./harness');
const { group, ok, done } = require('./assert');

const YT = 'https://www.youtube.com';
const tick = H.tick;

// A fresh page load: clean state, a mounted player, the module evaluated again.
async function boot(href, storeSeed) {
    H.reset();
    if (storeSeed) H.store['sekhmet_loopedVideos'] = storeSeed;
    H.nav(href);
    const v = H.newVideo('main');
    H.setDom({ '#movie_player video': v });
    H.loadModule('loop.js', 'YTELoop');
    YTELoop.init();
    await tick(); await tick();
    return v;
}

(async () => {
    group('the contract its callers depend on');
    {
        const v = await boot(`${YT}/watch?v=AAA`);
        YTELoop.init();                                  // index.js calls init() twice
        ok('currentKey() is the video id',   YTELoop.currentKey() === 'AAA');
        ok('isRemembered() false initially', YTELoop.isRemembered() === false);
        ok('video.loop left alone',          v.loop === false);
        YTELoop.toggle(); await tick(); await tick();
        ok('toggle() sets video.loop',       v.loop === true);
        ok('persisted under sekhmet_loopedVideos', 'AAA' in H.store['sekhmet_loopedVideos']);
    }

    group('every write re-contributes what this tab knows');
    {
        await boot(`${YT}/watch?v=BBB`, { AAA: 111, CCC: 222 });
        ok('hydrated the other entries', !YTELoop.isRemembered());

        // Another tab's write lands between this tab's read and its write, dropping
        // entries this tab still knows about. Folding the in-memory map back in is
        // what puts them back instead of the later write silently winning.
        H.store['sekhmet_loopedVideos'] = {};
        YTELoop.toggle(); await tick(); await tick(); await tick();

        const reg = H.store['sekhmet_loopedVideos'] || {};
        ok('AAA re-contributed', 'AAA' in reg);
        ok('CCC re-contributed', 'CCC' in reg);
        ok('BBB written',        'BBB' in reg);
    }

    group('un-remembering elsewhere stops the video here');
    {
        const v = await boot(`${YT}/watch?v=AAA`, { AAA: 111 });
        ok('loop asserted from storage', v.loop === true);
        H.otherTabWrote('sekhmet_loopedVideos', {});         // another tab pressed Shift+L
        ok('flag cleared on the same key', v.loop === false);
        ok('isRemembered() now false',     YTELoop.isRemembered() === false);
    }

    group('the documented escape hatch stops the current video');
    {
        const v = await boot(`${YT}/watch?v=AAA`, { AAA: 111 });
        H.otherTabWrote('sekhmet_loopedVideos', undefined);  // storage.local.remove(...)
        ok('flag cleared on a wholesale remove', v.loop === false);
    }

    group('a cold load that beats the player still asserts the loop');
    {
        H.reset();
        H.store['sekhmet_loopedVideos'] = { AAA: 111 };
        H.nav(`${YT}/watch?v=AAA`);
        H.setDom({});                                    // player has not mounted yet
        H.loadModule('loop.js', 'YTELoop');
        YTELoop.init();
        await tick(); await tick();
        ok('a wait for the player is pending', H.playerWaitPending());

        const v = H.newVideo('main');
        H.setDom({ '#movie_player video': v });
        H.playerArrives();
        ok('loop asserted once it mounts', v.loop === true);
    }

    group('holding the key is one instruction, not thirty');
    {
        const v = await boot(`${YT}/watch?v=AAA`);
        const before = H.toasts.length;
        H.key({ repeat: false });
        for (let i = 0; i < 20; i++) H.key({ repeat: true });
        await tick(); await tick();
        ok('exactly one toggle fired', H.toasts.length === before + 1);
        ok('ends up on, not flapping', v.loop === true);
    }

    group('the miniplayer keeps looping when you click through to a feed');
    {
        const v = await boot(`${YT}/watch?v=AAA`, { AAA: 111 });
        ok('looping on the watch page', v.loop === true);

        H.nav(`${YT}/`);                                 // miniplayer keeps the element
        H.dispatch('loadedmetadata', v);
        ok('still looping off a watch page', v.loop === true);

        H.nav(`${YT}/watch?v=BBB`);
        H.dispatch('loadstart', v);
        ok('cleared once a real new video arrives', v.loop === false);
    }

    group("YouTube's own Loop menu survives a seek");
    {
        const v = await boot(`${YT}/watch?v=AAA`, { AAA: 111 });
        v.loop = false;                                  // user unticks YouTube's Loop
        H.dispatch('canplay', v);                        // seek / stall recovery
        ok('not re-asserted on canplay', v.loop === false);
        H.dispatch('loadstart', v);                      // next playthrough
        ok('re-asserted on the next load', v.loop === true);
    }

    group('the hover-preview player is never mistaken for the main one');
    {
        H.reset();
        H.store['sekhmet_loopedVideos'] = { AAA: 111 };
        H.nav(`${YT}/watch?v=AAA`);
        // #movie_player has no <video> yet; a hovered sidebar thumbnail does, and
        // it carries .html5-main-video too.
        const preview = H.newVideo('preview');
        H.setDom({ 'video.html5-main-video': preview });
        H.loadModule('loop.js', 'YTELoop');
        YTELoop.init();
        await tick(); await tick();
        ok('preview left un-looped', preview.loop === false);
        ok('currentKey() is null',   YTELoop.currentKey() === null);
    }

    group('hydration must not resurrect what another tab deleted');
    {
        H.reset();
        H.store['sekhmet_loopedVideos'] = { AAA: 111 };
        H.nav(`${YT}/watch?v=AAA`);
        const v = H.newVideo('main');
        H.setDom({ '#movie_player video': v });
        H.loadModule('loop.js', 'YTELoop');
        YTELoop.init();
        H.otherTabWrote('sekhmet_loopedVideos', {});         // lands while the read is in flight
        await tick(); await tick();
        ok('AAA stays deleted',    YTELoop.isRemembered() === false);
        ok('flag not re-asserted', v.loop === false);
    }

    group('navigation');
    {
        const v = await boot(`${YT}/watch?v=AAA`, { AAA: 111 });
        ok('survives a reload', v.loop === true);

        H.nav(`${YT}/feed/subscriptions`);
        H.setDom({});
        H.mutate();
        ok('currentKey() null off a watch page', YTELoop.currentKey() === null);
        const before = H.toasts.length;
        YTELoop.toggle();
        ok('toggle() off a watch page is a no-op', H.toasts.length === before);
        ok('no runaway poll off a watch page',     !H.playerWaitPending());
        ok('the miniplayer video kept looping',    v.loop === true);

        // currentKey() is null while the player mounts, so comparing it would make
        // this look like no navigation at all and skip the wait.
        H.nav(`${YT}/watch?v=ZZZ`);
        H.setDom({});
        H.mutate();
        ok('a new watch page waits for its player', H.playerWaitPending());
    }

    group('the toast must not claim more than was written');
    {
        const v = await boot(`${YT}/watch?v=AAA`);
        YTELoop.toggle(); await tick(); await tick();
        ok('says remembered on a good write',      /remembered/.test(H.lastToast().text));
        ok('reported after the write, not before', H.lastToast().updates === 1);

        H.contextLost(true);                             // extension reloaded under us
        YTELoop.toggle(); await tick(); await tick();
        ok('does not claim remembered',   !/remembered/.test(H.lastToast().text));
        ok('says this page only',          /this page only/.test(H.lastToast().text));
        ok('flagged as an error',          H.lastToast().status === 'error');
        ok('the flag still came off now',  v.loop === false);

        H.contextLost(false);
        H.failWrites(true);                              // storage there, write rejects
        YTELoop.toggle(); await tick(); await tick(); await tick();
        H.failWrites(false);
        ok('a failed write is reported too', /this page only/.test(H.lastToast().text));
        ok('the loop still applies to this page', v.loop === true);
    }

    group('a failed read is not mistaken for an empty registry');
    {
        await boot(`${YT}/watch?v=BBB`, { AAA: 111, CCC: 222 });
        H.failReads(true);
        YTELoop.toggle(); await tick(); await tick(); await tick();
        H.failReads(false);

        const reg = H.store['sekhmet_loopedVideos'] || {};
        ok('nothing was written on a failed read', !('BBB' in reg));
        ok('the registry is intact',               'AAA' in reg && 'CCC' in reg);
        ok('and the user was told',                /this page only/.test(H.lastToast().text));
    }

    group('reading and writing times');
    {
        await boot(`${YT}/watch?v=AAA`);
        ok('plain seconds',       YTELoop.parseTime('90') === 90);
        ok('minutes:seconds',     YTELoop.parseTime('1:30') === 90);
        ok('hours',               YTELoop.parseTime('1:02:03') === 3723);
        ok('tenths',              YTELoop.parseTime('1:30.5') === 90.5);
        ok('blank is null',       YTELoop.parseTime('  ') === null);
        ok('garbage is NaN',      Number.isNaN(YTELoop.parseTime('abc')));
        ok('1:75 is NaN',         Number.isNaN(YTELoop.parseTime('1:75')));
        ok('formats under an hour', YTELoop.formatTime(90) === '1:30');
        ok('pads seconds',        YTELoop.formatTime(65) === '1:05');
        ok('formats hours',       YTELoop.formatTime(3723) === '1:02:03');
        ok('keeps tenths',        YTELoop.formatTime(90.5) === '1:30.5');
        ok('rounding carries',    YTELoop.formatTime(59.96) === '1:00');
    }

    group('a range has to make sense before it is saved');
    {
        await boot(`${YT}/watch?v=AAA`);
        const bad = (s, e, d) => YTELoop.rangeProblem(s, e, d) !== null;
        ok('a good range passes',        !bad(10, 20, 600));
        ok('blank end passes',           !bad(10, null, 600));
        ok('blank start passes',         !bad(null, 20, 600));
        ok('unreadable start refused',   bad(NaN, 20, 600));
        ok('unreadable end refused',     bad(10, NaN, 600));
        ok('backwards refused',          bad(20, 10, 600));
        ok('equal refused',              bad(10, 10, 600));
        ok('too short refused',          bad(10, 10.5, 600));
        ok('past the video refused',     bad(10, 700, 600));
        ok('start past the video refused', bad(700, null, 600));
        ok('unknown duration is not a refusal', !bad(10, 700, NaN));
        ok('blank end with no room refused',    bad(599.9, null, 600));
        ok('blank end with room passes',        !bad(598, null, 600));
        ok('exactly the minimum passes despite float error', !bad(3.1, 4.1, 600));
    }

    group('the range is kept with the remembered loop');
    {
        const v = await boot(`${YT}/watch?v=AAA`);
        ok('no range without a loop', await YTELoop.setRange(5, 10) === false);

        YTELoop.toggle(); await tick(); await tick();
        ok('saved', await YTELoop.setRange(5, 10) === true);
        ok('stored with the entry', H.store['sekhmet_loopedVideos'].AAA.start === 5
            && H.store['sekhmet_loopedVideos'].AAA.end === 10);
        ok('reads back', YTELoop.getRange().end === 10);
        ok('labelled for the menu', YTELoop.rangeLabel() === '0:05 – 0:10');
        ok('still looping', v.loop === true);

        await YTELoop.setRange(0, null);
        ok('the whole video is a plain entry again', typeof H.store['sekhmet_loopedVideos'].AAA === 'number');
        ok('and has no range', YTELoop.getRange() === null);

        await YTELoop.setRange(5, 10);
        YTELoop.toggle(); await tick(); await tick();
        ok('switching off forgets the range', !('AAA' in H.store['sekhmet_loopedVideos']));
        YTELoop.toggle(); await tick(); await tick();
        ok('switching on again is the whole video', YTELoop.getRange() === null);
    }

    group('a stored range survives a reload and a malformed one does not load');
    {
        const v = await boot(`${YT}/watch?v=AAA`, {
            AAA: { at: 111, start: 5, end: 10 },
            BAD: { at: 111, start: 'x', end: 10 }
        });
        ok('restored',         YTELoop.getRange().start === 5);
        ok('asserted looping', v.loop === true);

        H.nav(`${YT}/watch?v=BAD`);
        ok('bad entry ignored', YTELoop.isRemembered() === false);
    }

    group('playback stays inside the range');
    {
        const v = await boot(`${YT}/watch?v=AAA`, { AAA: { at: 111, start: 5, end: 10 } });
        const at = t => { v.currentTime = t; H.dispatch('timeupdate', v); return v.currentTime; };

        ok('inside is left alone',            at(7) === 7);
        ok('past the end goes back to start', at(10.1) === 5);
        ok('before the start is pulled in',   at(1) === 5);
        ok('a landing just short is not re-sought', at(4.9) === 4.9);

        v.paused = true;
        ok('a paused playhead can leave the range', at(30) === 30);
        v.paused = false;
        ok('pressing play from there comes back',   at(30) === 5);

        v.adShowing = true;
        ok('an ad is never seeked', at(30) === 30);
        v.adShowing = false;

        const other = H.newVideo('preview');
        other.currentTime = 30;
        H.dispatch('timeupdate', other);
        ok('other videos are left alone', other.currentTime === 30);
    }

    group('the end is hit between timeupdates');
    {
        const v = await boot(`${YT}/watch?v=AAA`, { AAA: { at: 111, start: 5, end: 10 } });
        v.currentTime = 9.95;
        H.dispatch('timeupdate', v);
        v.currentTime = 10;
        await new Promise(r => setTimeout(r, 80));
        ok('the timer took the last step', v.currentTime === 5);
    }

    group('the range belongs to its video');
    {
        const v = await boot(`${YT}/watch?v=AAA`, { AAA: { at: 111, start: 5, end: 10 } });

        H.nav(`${YT}/`);                                 // miniplayer keeps the element
        H.dispatch('loadedmetadata', v);
        v.currentTime = 30;
        H.dispatch('timeupdate', v);
        ok('still held in the miniplayer', v.currentTime === 5);

        H.nav(`${YT}/watch?v=BBB`);
        H.dispatch('loadstart', v);
        v.currentTime = 30;
        H.dispatch('timeupdate', v);
        ok('not applied to the next video', v.currentTime === 30);
    }

    group('a different video in the miniplayer drops the loop and the range');
    {
        const v = await boot(`${YT}/watch?v=AAA`, { AAA: { at: 111, start: 5, end: 10 } });

        H.nav(`${YT}/`);
        H.dispatch('loadedmetadata', v);                 // same video, reloaded
        ok('the same video keeps looping', v.loop === true);

        v.adShowing = true;
        v.duration = 15;
        H.dispatch('loadedmetadata', v);
        ok('an ad is not a different video', v.loop === true);
        v.adShowing = false;

        v.duration = 245;
        H.dispatch('loadstart', v);
        H.dispatch('loadedmetadata', v);
        ok('the flag comes off', v.loop === false);
        v.currentTime = 30;
        H.dispatch('timeupdate', v);
        ok('the range is not applied', v.currentTime === 30);
    }

    group("another video's timeupdate leaves the end timer alone");
    {
        const v = await boot(`${YT}/watch?v=AAA`, { AAA: { at: 111, start: 5, end: 10 } });
        v.currentTime = 9.95;
        H.dispatch('timeupdate', v);
        H.dispatch('timeupdate', H.newVideo('preview'));
        v.currentTime = 10;
        await new Promise(r => setTimeout(r, 80));
        ok('the timer still fired', v.currentTime === 5);
    }

    group('a start saved with no room to play is ignored');
    {
        const v = await boot(`${YT}/watch?v=AAA`, { AAA: { at: 111, start: 599.9, end: null } });
        v.currentTime = 10;
        H.dispatch('timeupdate', v);
        ok('no seek', v.currentTime === 10);
    }

    group('a whole-video loop never seeks');
    {
        const v = await boot(`${YT}/watch?v=AAA`, { AAA: 111 });
        v.currentTime = 30;
        H.dispatch('timeupdate', v);
        ok('left alone', v.currentTime === 30);
    }

    done();
})();
