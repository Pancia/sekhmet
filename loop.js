let YTELoop = (function() {
    const {log, debug, error} = initLogger("loop")

    // videoId -> remembered-at, or { at, start, end } once a part of the video has
    // been picked (end is null for "to the end of the video"). Permanent on purpose: unlike overlays' cleared
    // gates, which age out so a video gets to ask again, a loop is a standing
    // instruction and going quiet after a month would just look like a bug.
    // There is no settings page yet, so the escape hatch is
    // browser.storage.local.remove('sekhmet_loopedVideos') from the console.
    const STORAGE_KEY = 'sekhmet_loopedVideos';

    // The in-memory copy is what everything actually reads: the compass menu
    // renders its rows synchronously and a keypress has to answer immediately.
    const remembered = new Map();

    let installed = false;
    // The key we last set video.loop for, and only ever a key we set ourselves.
    // YouTube carries one <video> across SPA navigation, so without this a
    // remembered video would leave the *next* one looping - see sync().
    let assertedFor = null;
    // How long that video was when we last saw it, so a different video arriving
    // where the URL cannot say so (the miniplayer) can still be noticed.
    let assertedDuration = null;
    let lastKey = null;
    // Set by the first storage.onChanged, and checked before the hydration
    // snapshot is applied - see hydrated below.
    let storageChanged = false;
    let cancelPlayerWait = null;
    let rangeTimer = null;

    // Shorter than this and the player spends the whole loop seeking.
    const MIN_RANGE_SECONDS = 1;
    // A seek can land a hair before the time asked for. Without some slack the
    // landing would itself count as "before the start" and seek again, forever.
    const START_SLACK_SECONDS = 0.25;
    // timeupdate only fires about four times a second, which overshoots the end
    // audibly. Inside this distance of it, a timer takes the last step.
    const PRECISE_WINDOW_SECONDS = 0.5;
    // The fields hold tenths, so a range at the minimum can come out a little under
    // it from rounding or floating-point subtraction (4.1 - 3.1 is 0.9999...).
    const RANGE_SLACK_SECONDS = 0.1;

    function storageUsable() {
        try {
            return !!(browser && browser.runtime && browser.runtime.id);
        } catch (e) {
            return false;
        }
    }

    // --- what we are pointing at -------------------------------------------------

    // Never cached, for the reason volume.js and feeling-tracker.js both document:
    // YouTube pools player elements and swaps them, so a stored reference goes
    // stale without ever looking stale.
    //
    // The fallback is scoped to a player root rather than left as a bare
    // `video.html5-main-video`, which the hover-preview player's video also
    // carries. During the window where #movie_player has no <video> yet, a hovered
    // sidebar thumbnail would otherwise be the first match, and looping the
    // preview is both invisible and permanent - nothing later resolves back to it
    // to clear the flag.
    function findMainVideo() {
        return document.querySelector('#movie_player video')
            || document.querySelector('.html5-video-player:not(#inline-preview-player) video.html5-main-video');
    }

    // Watch pages only. Shorts already loop by themselves, and a feed, a search or
    // a channel page has no single video for this to be about. Identity comes from
    // the URL rather than the element, because the same <video> is reused from one
    // video to the next and so cannot tell them apart.
    function videoIdFromUrl() {
        if (window.location.hostname !== 'www.youtube.com') return null;
        if (!window.location.pathname.includes('/watch')) return null;
        try {
            return new URLSearchParams(window.location.search).get('v');
        } catch (e) {
            return null;
        }
    }

    // Null means "nothing here to loop", which the compass menu turns into a
    // disabled button and an "n/a" row rather than an error.
    function currentKey() {
        const id = videoIdFromUrl();
        if (!id) return null;
        return findMainVideo() ? id : null;
    }

    function isRemembered() {
        const key = currentKey();
        return !!key && remembered.has(key);
    }

    function rangeOf(entry) {
        return entry && typeof entry === 'object'
            ? { start: entry.start, end: entry.end }
            : null;
    }

    function getRange() {
        const key = currentKey();
        return key ? rangeOf(remembered.get(key)) : null;
    }

    // YouTube plays ads through the same <video>, so during one currentTime and
    // duration describe the ad rather than the video the range belongs to.
    function adShowing(video) {
        const player = video.closest('.html5-video-player');
        return !!player && player.classList.contains('ad-showing');
    }

    // --- times -------------------------------------------------------------------

    // Blank is null, unreadable is NaN: the two mean different things to the
    // caller, since a blank field is a legitimate "from the start" or "to the end".
    function parseTime(text) {
        const trimmed = String(text).trim();
        if (!trimmed) return null;
        if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(trimmed)) return NaN;

        const parts = trimmed.split(':').map(Number);
        if (parts.slice(1).some(part => part >= 60)) return NaN;
        return parts.reduce((total, part) => total * 60 + part, 0);
    }

    function formatTime(seconds) {
        const tenths = Math.round(seconds * 10);
        const whole = Math.floor(tenths / 10);
        const hours = Math.floor(whole / 3600);
        const minutes = Math.floor(whole / 60) % 60;
        const secs = String(whole % 60).padStart(2, '0') + (tenths % 10 ? `.${tenths % 10}` : '');
        return hours
            ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}`
            : `${minutes}:${secs}`;
    }

    function rangeLabel() {
        const range = getRange();
        if (!range) return null;
        return `${formatTime(range.start)} – ${range.end === null ? 'end' : formatTime(range.end)}`;
    }

    // Takes parseTime's output. Returns what is wrong in words for the dialog to
    // show, or null. An unknown duration (not loaded yet, or an ad) skips that one
    // check rather than refusing the whole range.
    function rangeProblem(start, end, duration) {
        if (Number.isNaN(start)) return 'Start should look like 1:23.';
        if (Number.isNaN(end)) return 'End should look like 1:23.';
        const from = start === null ? 0 : start;
        if (end !== null && from >= end) return 'Start must be before end.';
        const known = Number.isFinite(duration);
        // Half a second of slack: the fields round to tenths, and a time taken
        // at the very end of the video should not be refused for rounding up.
        if (known && (end === null ? from : end) > duration + 0.5) {
            return `The video is only ${formatTime(duration)} long.`;
        }
        // A blank end means the end of the video, which has a length like any other.
        const stop = end !== null ? end : (known ? duration : null);
        if (stop !== null && stop - from < MIN_RANGE_SECONDS - RANGE_SLACK_SECONDS) {
            return `The loop must be at least ${MIN_RANGE_SECONDS} second long.`;
        }
        return null;
    }

    // --- the registry ------------------------------------------------------------

    // Raw storage rather than lib.js's Cookies helper. Cookies.get swallows the
    // rejection and answers null for "never written" *and* for "the read failed"
    // (lib.js:491-497), and Cookies.set swallows write failures entirely - both
    // distinctions this has to make. feeling-tracker.js:14-41 takes the same route
    // for the same reason.
    function readRegistry() {
        return browser.storage.local.get(STORAGE_KEY).then(r => r[STORAGE_KEY] || {});
    }

    // Read-merge-write, seeded from the stored copy *and* the in-memory map, so
    // each tab re-contributes everything it knows. Two tabs toggling different
    // videos inside one round trip would otherwise both merge the same snapshot and
    // the later write would silently drop the earlier video. This narrows that
    // window rather than closing it - storage.local has no transaction - but a lost
    // update now needs the two writes to actually overlap, rather than merely a
    // slow read. overlays.js:817-830 merges the same way.
    //
    // Deleting is what makes "off" stick - an absent entry *is* the off state,
    // since there is no TTL here to age one out - and `remembered` has already had
    // the key removed by the time toggle() calls this.
    //
    // Resolves true only when the write actually landed, so toggle() can tell the
    // user when their choice is not going to outlive the page.
    function persist(key, on) {
        if (!storageUsable()) return Promise.resolve(false);

        // Taken now: another tab's write can clear the map before the read returns.
        const entry = remembered.get(key);
        return readRegistry().then(stored => {
            const merged = Object.assign({}, stored);
            remembered.forEach((at, k) => { merged[k] = at; });
            if (on) { merged[key] = entry; } else { delete merged[key]; }
            return browser.storage.local.set({ [STORAGE_KEY]: merged });
        }).then(() => true).catch(err => {
            error(`could not persist the loop registry: ${err}`);
            return false;
        });
    }

    function isValidEntry(entry) {
        if (typeof entry === 'number') return true;
        return !!entry && typeof entry === 'object'
            && typeof entry.at === 'number'
            && typeof entry.start === 'number'
            && (entry.end === null || typeof entry.end === 'number');
    }

    function loadEntries(stored) {
        Object.entries(stored || {}).forEach(([key, entry]) => {
            if (isValidEntry(entry)) remembered.set(key, entry);
        });
    }

    // Started at load rather than at first use, so the round trip to the background
    // page overlaps with the player setting itself up. Losing that race costs
    // nothing: a remembered video only needs its flag by the time it reaches the end.
    const hydrated = (storageUsable()
        ? readRegistry()
        : Promise.resolve(null)
    ).then(stored => {
        // If another tab has written since this read was issued, the snapshot in
        // hand predates that write. Applying it would re-add an entry that tab just
        // deleted, and nothing further would write to settle the disagreement.
        if (storageChanged) {
            debug('registry already refreshed by another tab, dropping the hydration snapshot');
            return;
        }
        loadEntries(stored);
        log(`restored ${remembered.size} looped videos`);
    }).catch(err => {
        error(`could not read the loop registry: ${err}`);
    });

    // --- applying it -------------------------------------------------------------

    function noteAsserted(key, video) {
        if (assertedFor !== key) assertedDuration = null;
        assertedFor = key;
        if (!key || !video || adShowing(video)) return;
        if (Number.isFinite(video.duration) && video.duration > 0) assertedDuration = video.duration;
    }

    // The length rather than the player's title link: it needs no knowledge of
    // YouTube's markup. Two videos of the same length go unnoticed, and an
    // unknown length or an ad counts as no evidence, which leaves the loop on.
    function loadedDifferentVideo(video) {
        if (assertedDuration === null || adShowing(video)) return false;
        return Number.isFinite(video.duration) && video.duration > 0
            && Math.abs(video.duration - assertedDuration) > 1;
    }

    function sync() {
        const key = currentKey();
        const video = findMainVideo();
        // Nothing mounted yet. Leave assertedFor alone so the next sync - the new
        // video's loadstart, or the poll below - gets another go at it.
        if (!video) return;

        // Asserting the true side is unconditional: this is the switch the feature
        // exists to remember.
        if (key && remembered.has(key)) {
            if (!video.loop) video.loop = true;
            noteAsserted(key, video);
            return;
        }

        // Past here the flag should be off, but only if it is ours to turn off. A
        // loop the user set through YouTube's own right-click menu is left alone.
        if (!assertedFor) return;

        // A null key is not evidence that our video went away. Clicking through to
        // the feed leaves the miniplayer playing the very same element, and
        // clearing there would stop a remembered video looping mid-watch with no
        // way to put it back - off a watch page both Shift+L and the compass button
        // are dead. Wait for a real new key instead, or for the miniplayer itself
        // to load something of a different length.
        if (!key && !loadedDifferentVideo(video)) return;

        if (video.loop) video.loop = false;
        noteAsserted(null, video);
    }

    function toggle() {
        const key = currentKey();
        if (!key) {
            debug('no video on this page to loop');
            return;
        }

        const on = !remembered.has(key);
        if (on) { remembered.set(key, Date.now()); } else { remembered.delete(key); }

        const video = findMainVideo();
        // The one place false gets forced regardless of who set it: the user just
        // asked for it, so this is not us overruling YouTube's menu behind their back.
        if (video) video.loop = on;
        noteAsserted(on ? key : null, video);

        // Sticky until the write settles, then updated with the outcome. The flag
        // on the element is already set either way; what is still in doubt is
        // whether the choice outlives this page, and claiming "remembered" before
        // knowing that is the one thing this toast must not do. Storage answers in
        // single-digit milliseconds, so in practice it reads as a single toast.
        // The write is started before the toast, so a DOM problem raising out of
        // showToast cannot cost the user the setting itself.
        const pending = persist(key, on);
        const toast = showToast(
            on ? "🔁 Looping this video" : "Loop off for this video",
            { status: on ? "ok" : "info", timeout: 0 }
        );

        pending.then(written => {
            if (written) {
                toast.update(
                    on ? "🔁 Looping this video — remembered" : "Loop off for this video",
                    { status: on ? "ok" : "info", timeout: 2500 }
                );
                return;
            }
            // Usually means the extension was reloaded with this page still open,
            // which leaves storage unreachable from a content script that is
            // otherwise still running perfectly well.
            toast.update(
                on ? "🔁 Looping — this page only" : "Loop off — this page only",
                {
                    status: "error",
                    detail: "Couldn't save it; this won't survive a reload.",
                    timeout: 6000
                }
            );
        });

        log(`loop ${on ? 'on' : 'off'} for ${key}`);
    }

    // --- the part of the video to loop -------------------------------------------

    // Goes by assertedFor rather than the URL, so a range keeps holding in the
    // miniplayer on the feed, for the same reason sync() leaves the flag on there.
    //
    // Paused is exempt so the playhead can be dragged outside the range to pick a
    // new start or end. Pressing play from out there is caught by the next tick.
    function enforceRange(video) {
        // First, so a hover preview's timeupdate cannot cancel the main video's timer.
        if (video !== findMainVideo()) return;

        clearTimeout(rangeTimer);
        rangeTimer = null;

        const range = assertedFor ? rangeOf(remembered.get(assertedFor)) : null;
        if (!range || video.paused || adShowing(video)) return;

        // A start saved while the length was unknown can leave no room to play.
        if (Number.isFinite(video.duration) && range.start > video.duration - MIN_RANGE_SECONDS) return;

        const time = video.currentTime;
        const end = range.end === null ? Infinity : range.end;
        if (time >= end || time < range.start - START_SLACK_SECONDS) {
            video.currentTime = range.start;
            return;
        }

        const left = (end - time) / (video.playbackRate || 1);
        if (left < PRECISE_WINDOW_SECONDS) {
            rangeTimer = setTimeout(() => enforceRange(video), left * 1000);
        }
    }

    // Resolves true when the choice was saved. A start of 0 and no end is simply
    // the whole video, which goes back to being a plain timestamp.
    function setRange(start, end) {
        const key = currentKey();
        if (!key || !remembered.has(key)) return Promise.resolve(false);

        const entry = remembered.get(key);
        const at = typeof entry === 'number' ? entry : entry.at;
        remembered.set(key, start === 0 && end === null ? at : { at, start, end });
        return persist(key, true);
    }

    // Null while the length is unknown, and during an ad, whose length is the ad's.
    function knownDuration() {
        const video = findMainVideo();
        if (!video || adShowing(video)) return null;
        return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    }

    // A click moves whichever of start and end is nearer; dragging refines it. The
    // text fields stay the source of truth, so the bar only ever writes to them and
    // both ways of setting a time share commit()'s checks and save.
    function rangeTimeline(startInput, endInput, commit) {
        function piece(styles) {
            const el = document.createElement('div');
            Object.assign(el.style, { position: 'absolute', pointerEvents: 'none' }, styles);
            return el;
        }

        const bar = document.createElement('div');
        bar.id = 'sekhmet-loop-timeline';
        bar.title = 'Click or drag to set the start and end';
        Object.assign(bar.style, {
            position: 'relative', height: '28px', margin: '4px 9px 10px',
            cursor: 'pointer', touchAction: 'none', userSelect: 'none'
        });

        const rail = piece({ left: '0', right: '0', top: '11px', height: '6px', borderRadius: '3px', backgroundColor: '#ddd' });
        const fill = piece({ top: '11px', height: '6px', backgroundColor: '#673AB7' });
        const playhead = piece({ top: '4px', width: '2px', height: '20px', marginLeft: '-1px', backgroundColor: '#F44336' });
        const handle = () => piece({
            top: '2px', width: '12px', height: '24px', marginLeft: '-6px', boxSizing: 'border-box',
            borderRadius: '4px', border: '2px solid #673AB7', backgroundColor: 'white'
        });
        const startHandle = handle();
        const endHandle = handle();
        bar.append(rail, fill, playhead, startHandle, endHandle);

        function values(duration) {
            const start = parseTime(startInput.value);
            const end = parseTime(endInput.value);
            return {
                start: Number.isFinite(start) ? start : 0,
                end: Number.isFinite(end) ? end : duration
            };
        }

        function paint() {
            const duration = knownDuration();
            bar.style.display = duration ? 'block' : 'none';
            if (!duration) return;

            const percent = time => Math.min(100, Math.max(0, time / duration * 100));
            const { start, end } = values(duration);
            startHandle.style.left = `${percent(start)}%`;
            endHandle.style.left = `${percent(end)}%`;
            fill.style.left = `${percent(start)}%`;
            fill.style.width = `${Math.max(0, percent(end) - percent(start))}%`;
            playhead.style.left = `${percent(findMainVideo().currentTime)}%`;
        }

        // Handles stay a legal distance apart, so a drag can never produce a range
        // commit() would refuse. Landing at either extreme means the plain "from
        // the start" or "to the end", rather than a time a fraction short of it.
        function place(which, time, duration) {
            const { start, end } = values(duration);
            if (which === 'start') {
                const limited = Math.max(0, Math.min(time, end - MIN_RANGE_SECONDS));
                startInput.value = formatTime(limited < 0.25 ? 0 : limited);
            } else {
                const limited = Math.min(duration, Math.max(time, start + MIN_RANGE_SECONDS));
                endInput.value = limited >= duration - 0.25 ? '' : formatTime(limited);
            }
            paint();
        }

        function timeAt(event, duration) {
            const rect = bar.getBoundingClientRect();
            return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * duration;
        }

        let dragging = null;

        bar.addEventListener('pointerdown', event => {
            const duration = knownDuration();
            if (!duration || event.button !== 0) return;
            event.preventDefault();

            const time = timeAt(event, duration);
            const { start, end } = values(duration);
            dragging = Math.abs(time - start) <= Math.abs(time - end) ? 'start' : 'end';
            bar.setPointerCapture(event.pointerId);
            place(dragging, time, duration);
        });

        bar.addEventListener('pointermove', event => {
            if (!dragging) return;
            // No button held means the release went somewhere we could not see.
            if (event.buttons === 0) {
                finish();
                return;
            }
            const duration = knownDuration();
            if (duration) place(dragging, timeAt(event, duration), duration);
        });

        function finish() {
            if (!dragging) return;
            dragging = null;
            commit();
        }
        bar.addEventListener('pointerup', finish);
        bar.addEventListener('pointercancel', finish);
        bar.addEventListener('lostpointercapture', finish);

        // Keeps the playhead moving, and shows the bar once the length is known or
        // an ad ends. Stops itself when the dialog closes and takes the bar with it.
        const refresh = setInterval(() => {
            if (bar.isConnected) { paint(); } else { clearInterval(refresh); }
        }, 250);

        paint();
        return { element: bar, paint };
    }

    // Lives here rather than in the compass menu so the menu only has to place it.
    function rangeControls() {
        const boundKey = currentKey();
        const wrap = document.createElement('div');
        wrap.style.marginTop = '10px';
        wrap.style.padding = '12px';
        wrap.style.border = '1px solid #ddd';
        wrap.style.borderRadius = '6px';
        wrap.style.fontSize = '18px';

        const status = document.createElement('div');
        status.style.marginTop = '8px';
        status.style.fontSize = '15px';

        function show(text, color) {
            status.textContent = text;
            status.style.color = color;
        }

        function showCurrent() {
            const label = rangeLabel();
            show(label ? `Looping ${label}` : 'Looping the whole video', '#4CAF50');
        }

        function commit() {
            // Saving goes by the URL at this moment, and these fields describe the
            // video they were built for.
            if (currentKey() !== boundKey || !isRemembered()) {
                show('This video is no longer looping here. Reopen this menu.', '#F44336');
                return;
            }

            const start = parseTime(startField.input.value);
            const end = parseTime(endField.input.value);
            const duration = knownDuration();

            // Both fields are checked together and nothing is saved until they
            // agree, so moving 0:10-0:20 to 0:30-0:40 works with either edit first.
            const problem = rangeProblem(start, end, duration);
            if (problem) {
                show(problem, '#F44336');
                return;
            }

            const from = start === null ? 0 : start;
            startField.input.value = formatTime(from);
            endField.input.value = end === null ? '' : formatTime(end);
            timeline.paint();

            setRange(from, end).then(written => {
                if (written) {
                    showCurrent();
                } else {
                    show("Set for this page only. Couldn't save it.", '#F44336');
                }
            });
        }

        function field(labelText, placeholder, value) {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.gap = '8px';
            row.style.marginBottom = '8px';

            const label = document.createElement('span');
            label.textContent = labelText;
            label.style.fontWeight = 'bold';
            label.style.width = '56px';

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = placeholder;
            input.value = value;
            input.setAttribute('aria-label', `Loop ${labelText.toLowerCase()} time`);
            input.style.flex = '1';
            input.style.minWidth = '0';
            input.style.padding = '8px';
            input.style.fontSize = '18px';
            input.style.color = '#333';
            input.style.backgroundColor = 'white';
            input.style.border = '1px solid #ccc';
            input.style.borderRadius = '4px';
            input.addEventListener('change', commit);
            input.addEventListener('keydown', event => {
                // Digits and arrows are player shortcuts on YouTube.
                event.stopPropagation();
                if (event.key === 'Enter') input.blur();
            });

            const now = document.createElement('button');
            now.textContent = 'Use current time';
            now.style.padding = '8px 10px';
            now.style.border = 'none';
            now.style.borderRadius = '4px';
            now.style.backgroundColor = '#673AB7';
            now.style.color = 'white';
            now.style.cursor = 'pointer';
            now.style.fontSize = '15px';
            now.addEventListener('click', () => {
                const video = findMainVideo();
                if (!video) return;
                if (adShowing(video)) {
                    show('An ad is playing. Try again when it ends.', '#F44336');
                    return;
                }
                input.value = formatTime(video.currentTime);
                commit();
            });

            row.append(label, input, now);
            wrap.appendChild(row);
            return { input };
        }

        const range = getRange();
        const startField = field('Start', '0:00', formatTime(range ? range.start : 0));
        const endField = field('End', 'end of video',
            range && range.end !== null ? formatTime(range.end) : '');
        const timeline = rangeTimeline(startField.input, endField.input, commit);

        const whole = document.createElement('button');
        whole.textContent = 'Loop the whole video';
        whole.style.width = '100%';
        whole.style.padding = '8px';
        whole.style.border = '1px solid #ccc';
        whole.style.borderRadius = '4px';
        whole.style.backgroundColor = 'white';
        whole.style.color = '#333';
        whole.style.cursor = 'pointer';
        whole.style.fontSize = '15px';
        whole.addEventListener('click', () => {
            startField.input.value = '';
            endField.input.value = '';
            commit();
        });

        wrap.append(timeline.element, whole, status);
        showCurrent();
        return wrap;
    }

    // --- keys --------------------------------------------------------------------

    function onKeyDown(event) {
        if (!event.shiftKey) return;
        // "L" normally, "l" when caps lock is on as well.
        if (event.key !== 'L' && event.key !== 'l') return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        // Holding the key is one instruction, not thirty. Without this, autorepeat
        // fires ~30 toggles a second, each with its own unserialized read-merge-write,
        // and they commit out of order.
        if (event.repeat) return;
        if (event.isComposing || event.keyCode === 229) return;

        // Our own modals.
        if (document.getElementById('feeling-dialog')) return;
        if (document.getElementById('sekhmet-ft-status-menu-backdrop')) return;

        if (isTypingTarget(event)) return;

        // Off a watch page the key means nothing here, so leave it to the page.
        if (!currentKey()) return;

        // YouTube reads a bare "l" as seek-forward-10s without checking shift, so
        // the key has to be taken away from it rather than merely acted on.
        event.preventDefault();
        event.stopImmediatePropagation();

        toggle();
    }

    // --- staying in sync ---------------------------------------------------------

    // Media events do not bubble, but a capturing listener on document still sees
    // them on the way down to the target - which is what lets this survive YouTube
    // swapping the element out from under us.
    //
    // loadstart and loadedmetadata only. Both mean a source was (re)loaded, which
    // is the boundary a remembered loop should be re-applied at. canplay also fires
    // after every seek and every stall recovery, and re-asserting there would
    // silently undo YouTube's own Loop menu mid-playthrough - unticking it would
    // appear to do nothing on exactly the videos this feature owns.
    function watchMedia() {
        ['loadstart', 'loadedmetadata'].forEach(type => {
            document.addEventListener(type, event => {
                if (!(event.target instanceof HTMLVideoElement)) return;
                sync();
            }, true);
        });

        // Separate from the above: this one fires constantly and only ever seeks.
        document.addEventListener('timeupdate', event => {
            if (event.target instanceof HTMLVideoElement) enforceRange(event.target);
        }, true);
    }

    // A direct load of a remembered watch page can beat the player: #movie_player
    // has no <video> yet, so the sync after hydration does nothing, and the media
    // events that would normally cover it have already fired. Every other module
    // here waits for the player rather than assuming it - overlays.js:1120,
    // and initializeFeelingTracker retries itself.
    //
    // Cancelled and restarted per navigation, because waitForElementToBeLoaded has
    // no iteration cap: one left running for a page we have left would poll for the
    // life of the tab.
    function waitForPlayer() {
        if (cancelPlayerWait) { cancelPlayerWait(); cancelPlayerWait = null; }
        if (!videoIdFromUrl()) return;   // nothing to wait for off a watch page
        if (findMainVideo()) return;

        cancelPlayerWait = waitForElementToBeLoaded('#movie_player video', () => {
            cancelPlayerWait = null;
            sync();
        });
    }

    // No navigation event to hook, so this rides the DOM churn like youtube.js
    // does. The href comparison comes first deliberately: this fires on every
    // mutation on a page that mutates constantly, and currentKey() is two
    // querySelectors that would otherwise run thousands of times a minute.
    function watchNavigation() {
        lastKey = videoIdFromUrl();
        let lastHref = window.location.href;

        new MutationObserver(() => {
            if (window.location.href === lastHref) return;
            lastHref = window.location.href;

            // The URL's own idea of identity, not currentKey(): that returns null
            // while the player is still mounting, so a feed -> watch navigation
            // would compare null to null, look like no change, and skip the wait
            // below - which is exactly the case the wait exists for. Comparing ids
            // also means a bare "&t=" stamp on the same video is correctly no
            // navigation at all.
            const key = videoIdFromUrl();
            if (key === lastKey) return;
            lastKey = key;
            sync();
            waitForPlayer();
        }).observe(document, { subtree: true, childList: true });
    }

    // Another tab toggling the same video should not leave this one's menu
    // claiming the opposite, and this settles the toggle-here/hydrate-there race
    // for free. Our own writes come back through here too, where they are no-ops.
    function watchStorage() {
        if (!storageUsable()) return;

        try {
            browser.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local' || !changes[STORAGE_KEY]) return;

                storageChanged = true;
                remembered.clear();
                loadEntries(changes[STORAGE_KEY].newValue);
                sync();
            });
        } catch (e) {
            debug('storage.onChanged unavailable', e);
        }
    }

    function init() {
        if (installed) return;   // index.js calls init() twice
        installed = true;

        // Window capture for the same reason volume.js uses it: it is the first
        // stop in the propagation path, ahead of both YouTube's own shortcuts and
        // the document-capture handler in youtube.js.
        window.addEventListener('keydown', onKeyDown, true);

        watchMedia();
        watchNavigation();
        watchStorage();

        hydrated.then(() => {
            sync();
            waitForPlayer();
        });
        log('per-video loop installed (Shift+L)');
    }

    return {
        init, currentKey, isRemembered, toggle,
        getRange, setRange, rangeLabel, rangeControls,
        parseTime, formatTime, rangeProblem
    };
})();
