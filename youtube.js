let initializeYoutube = (function() {
    const {log, debug, error} = initLogger("enhancements")

    function disableShortsScrolling() {
        const shortsContainer = document.querySelector('ytd-shorts');
        if (!shortsContainer || shortsContainer.dataset.scrollDisabled) return;

        shortsContainer.style.overflow = 'hidden';
        shortsContainer.dataset.scrollDisabled = 'true';

        const blockUnlessComments = e => {
            if (e.target.closest('ytd-comments, ytd-engagement-panel-section-list-renderer')) return;
            e.preventDefault();
        };
        shortsContainer.addEventListener('wheel', blockUnlessComments, { passive: false });
        shortsContainer.addEventListener('touchmove', blockUnlessComments, { passive: false });

        log('Shorts scrolling disabled');
    }

    function initializeYoutube() {
        document.addEventListener('keydown', (event) => {
            // Block arrow keys on Shorts pages to prevent navigating to next/prev short
            if (window.location.host === "www.youtube.com" && window.location.pathname.startsWith('/shorts')) {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }

            if (window.location.host == "www.youtube.com" && window.location.pathname == "/watch") {
                const activeElement = document.activeElement;
                const isInputField = ['input', 'textarea'].includes(activeElement.tagName.toLowerCase());
                debug(event, activeElement, isInputField)
                if (event.key === 'n' && !event.shiftKey && !isInputField) {
                    document.querySelector(".ytp-next-button").click();
                }
                if (event.key === 'p' && !event.shiftKey && !isInputField) {
                    document.querySelector(".ytp-prev-button").click();
                }
            }
        }, { capture: true });
        // Disable Shorts scrolling - use observer since YouTube is a SPA
        if (window.location.pathname.startsWith('/shorts')) {
            waitForElementToBeLoaded('ytd-shorts', disableShortsScrolling);
        }
        let lastPath = window.location.pathname;
        new MutationObserver(() => {
            if (window.location.pathname !== lastPath) {
                lastPath = window.location.pathname;
                if (lastPath.startsWith('/shorts')) {
                    waitForElementToBeLoaded('ytd-shorts', disableShortsScrolling);
                }
            }
        }).observe(document, { subtree: true, childList: true });

        if (window.location.pathname === "/") {
            waitForElementToBeLoaded("ytd-mini-guide-renderer > #items", () => {
                document.querySelectorAll("#wl-endpoint").forEach(i => i.remove())
                const items = document.querySelector("ytd-mini-guide-renderer > #items");
                const watchLaterLink = document.createElement("a");
                watchLaterLink.id = "wl-endpoint";
                watchLaterLink.tabIndex = "-1";
                watchLaterLink.className = "yt-simple-endpoint style-scope ytd-mini-guide-entry-renderer";
                watchLaterLink.title = "Library";
                watchLaterLink.href = "/playlist?list=WL";
                watchLaterLink.innerHTML = '<span style="font-size:24px">🕓</span><span class="title style-scope ytd-mini-guide-entry-renderer">Watch Later</span>';
                items.insertAdjacentElement('afterend', watchLaterLink);
            });
        }
    }
    return initializeYoutube
})();
