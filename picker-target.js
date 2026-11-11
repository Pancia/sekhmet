// Remembers which element the last right-click landed on, so the element picker
// (picker.js, injected from the right-click menu) can start on that element
// instead of asking you to point at it again. Runs on every page and does
// nothing else.
//
// The picker is injected into this same content-script world, so a property on
// window is enough to hand the element over. Window capture runs before the
// page's own contextmenu handlers, so a site that swallows the event still
// reports its target here.
(function() {
    if ('__sekhmetContextTarget' in window) return;
    window.__sekhmetContextTarget = null;
    window.addEventListener('contextmenu', (event) => {
        let el = event.target;
        if (el && el.nodeType !== 1) el = el.parentElement;
        window.__sekhmetContextTarget = el ? { el, at: Date.now() } : null;
    }, { capture: true });
})();
