// Gives the native right-click menu back on sites that take it away.
//
// solarmoviesz.co does it the usual way - a contextmenu listener on document
// that calls preventDefault. A capture listener on window runs before anything
// registered on document, so stopping the event there means the page's handlers
// never see it and the browser's menu opens as normal. Runs at document_start so
// it is in place before the page's own scripts, though window capture would win
// on ordering regardless.
//
// Only the top frame: a cross-origin player iframe is a different site with its
// own rules, and would need its own manifest match.
//
// The sites are matched by name in the host, since solarmovie mirrors churn
// through domains. Match patterns can't wildcard part of a host, so the manifest
// matches every URL and narrows with an include_glob - but a glob's * also
// crosses slashes, letting "solarmovie" in a path or query through too. The
// host check here is the real filter.
const ALLOW_RIGHT_CLICK_HOSTS = [/solarmovie/i];

if (ALLOW_RIGHT_CLICK_HOSTS.some(re => re.test(location.hostname))) {
    window.addEventListener('contextmenu', (event) => {
        event.stopImmediatePropagation();
    }, { capture: true });
}
