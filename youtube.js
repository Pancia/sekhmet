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

    // The "Ask about this video" (Ask AI) panel's text is small for reading at a
    // distance. The panel is matched by its target-id - YouTube's class names
    // there are generated and churn. Its children set their own font sizes, so
    // setting one on #content alone wouldn't cascade - even <strong> and the
    // timestamp spans carry their own - so every descendant gets it, !important.
    const ASK_AI_STYLE_ID = "sekhmet-ask-ai-text";
    //
    // The panel is also capped at the player's height; that cap is lifted and the
    // panel made drag-resizable from its bottom-right corner. The :not(#_) is
    // there for specificity only - YouTube's height rules go through an id, and
    // height can't be !important or it would beat the inline height the resize
    // handle writes.
    const ASK_AI_CSS = `
        ytd-engagement-panel-section-list-renderer[target-id="PAyouchat"]:not(#_) {
            height: 80vh;
            min-height: 300px !important;
            max-height: none !important;
            resize: vertical;
            overflow: hidden;
        }
        ytd-engagement-panel-section-list-renderer[target-id="PAyouchat"] #content * {
            font-size: 24px !important;
            line-height: 34px !important;
        }
    `;

    function enlargeAskAiText() {
        if (document.getElementById(ASK_AI_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = ASK_AI_STYLE_ID;
        style.textContent = ASK_AI_CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    // "?" opens YouTube's keyboard-shortcuts dialog but does nothing once it's
    // open, so close it ourselves to make "?" a toggle. The dialog element stays
    // in the DOM after closing (just hidden), hence the visibility check. Closing
    // goes through a synthetic Escape, which the dialog's overlay manager already
    // honours - its methods live in the page's JS world, out of a content
    // script's reach on Chromium.
    function closeHotkeyDialogIfOpen() {
        const dialog = document.querySelector('ytd-hotkey-dialog-renderer');
        if (!dialog || dialog.getClientRects().length === 0) return false;
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, composed: true
        }));
        return true;
    }

    function initializeYoutube() {
        enlargeAskAiText();
        document.addEventListener('keydown', (event) => {
            if (event.key === '?' && !isTypingTarget(event) && closeHotkeyDialogIfOpen()) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            // Block arrow keys on Shorts pages to prevent navigating to next/prev short.
            // volume.js normally claims these first from window capture; this still
            // fires whenever it declines. Skipped while typing so the arrows can
            // still move the caret in a Shorts comment.
            if (window.location.host === "www.youtube.com" && window.location.pathname.startsWith('/shorts')
                && !isTypingTarget(event)) {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }

            if (window.location.host == "www.youtube.com" && window.location.pathname == "/watch") {
                // Not a plain tagName check: YouTube's comment box is contenteditable,
                // so typing the letter "n" in a comment used to skip the video.
                const isInputField = isTypingTarget(event);
                debug(event, document.activeElement, isInputField)
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
