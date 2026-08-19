// Page-context bridge for the YouTube player's volume API.
//
// The player exposes getVolume/setVolume/isMuted/unMute as expandos on the
// #movie_player element. Those live in the page's JS world, which a Chromium
// content script cannot see at all — Firefox has wrappedJSObject for exactly this,
// Chromium has nothing. So on Chromium volume.js injects this file into the page
// and the two halves talk over the DOM, which both worlds share.
//
// Why the player API rather than just writing video.volume: YouTube applies
// per-video loudness normalization by scaling the media element, so video.volume
// is (slider / 100) * normalizationGain and reads e.g. 0.45 while the slider says
// 100. The API speaks in the slider's own 0-100 units, which is what the user's
// volume ladder is written in.
//
// Protocol, both directions anchored on the player element itself:
//   content -> page   CustomEvent 'yte-volume-cmd', detail is a JSON *string*
//                     (object payloads do not survive the world boundary intact)
//   page -> content   data-yte-vol / data-yte-muted attributes
//
// Reads go through the attributes so the keydown handler never has to await a
// round trip. Dispatch is synchronous, so a read taken straight after a write
// already sees the new value.
(function() {
    if (window.__yteVolumeBridge) return;
    window.__yteVolumeBridge = true;

    const MIRROR_MS = 500;

    function apiOf(el) {
        if (!el || typeof el.getVolume !== 'function' || typeof el.setVolume !== 'function') {
            return null;
        }
        return el;
    }

    // Mirror every player on the page rather than guessing which one the content
    // script resolved — a watch page can have the main player, an ad player and a
    // hover preview mounted at once.
    function mirror() {
        const players = document.querySelectorAll('.html5-video-player');
        for (const el of players) {
            const api = apiOf(el);
            if (!api) continue;
            let volume;
            try {
                volume = String(Math.round(api.getVolume()));
            } catch (e) {
                continue;   // player mid-teardown
            }
            const muted = (typeof api.isMuted === 'function' && api.isMuted()) ? '1' : '0';
            // Only write on an actual change: attribute churn wakes up every
            // MutationObserver on the page, YouTube's included.
            if (el.getAttribute('data-yte-vol') !== volume) {
                el.setAttribute('data-yte-vol', volume);
            }
            if (el.getAttribute('data-yte-muted') !== muted) {
                el.setAttribute('data-yte-muted', muted);
            }
        }
    }

    document.addEventListener('yte-volume-cmd', function(event) {
        const api = apiOf(event.target);
        if (!api) return;

        let cmd;
        try {
            cmd = JSON.parse(event.detail);
        } catch (e) {
            return;
        }

        try {
            // setVolume does not unmute on its own, so the two have to be paired.
            if (cmd.unmute && typeof api.unMute === 'function') api.unMute();
            if (typeof cmd.volume === 'number') api.setVolume(cmd.volume);
        } catch (e) {
            return;
        }

        mirror();   // synchronous, so the caller's next read is already current
    });

    setInterval(mirror, MIRROR_MS);
    mirror();
})();
