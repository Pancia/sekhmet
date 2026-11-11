// x.com: the toggle for the sidebar x.css hides. Shown or hidden is an attribute
// on <html>, which the stylesheet keys off; this file just owns the button.
//
// Hidden again on every page load - the point is that it is off unless you
// reach for it. Within a tab it holds, because X navigates without reloading.
(function() {
    const {log} = initLogger("x-sidebar")

    const ATTR = 'data-sekhmet-sidebar';

    function shown() {
        return document.documentElement.getAttribute(ATTR) === 'shown';
    }

    function render(button) {
        // The arrow points the way the sidebar will move; x.css turns it round
        // off aria-pressed.
        button.title = shown() ? 'Hide sidebar' : 'Show sidebar';
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-pressed', String(shown()));
    }

    // Built node by node rather than through innerHTML, which X's Trusted Types
    // policy would be within its rights to refuse.
    function chevron() {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', 'M15 4 7 12l8 8');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '3');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
        return svg;
    }

    function init() {
        if (document.getElementById('sekhmet-x-sidebar-toggle')) { return; }

        const button = document.createElement('button');
        button.id = 'sekhmet-x-sidebar-toggle';
        button.type = 'button';
        button.appendChild(chevron());
        button.addEventListener('click', () => {
            document.documentElement.setAttribute(ATTR, shown() ? 'hidden' : 'shown');
            render(button);
            log(`Sidebar ${shown() ? 'shown' : 'hidden'}`);
        });
        render(button);

        // On <html>, not <body>: React owns everything under X's root, and body
        // is close enough to it that leaving it alone is the safe default.
        document.documentElement.appendChild(button);
    }

    init();
})();
