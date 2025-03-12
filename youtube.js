function initializeYoutube() {
    document.addEventListener('keydown', (event) => {
        if (window.location.host == "www.youtube.com" && window.location.pathname == "/watch") {
            const activeElement = document.activeElement;
            const isInputField = ['input', 'textarea'].includes(activeElement.tagName.toLowerCase());
            console.log(event, activeElement, isInputField)
            if (event.key === 'n' && !event.shiftKey && !isInputField) {
                document.querySelector(".ytp-next-button").click();
            }
            if (event.key === 'p' && !event.shiftKey && !isInputField) {
                document.querySelector(".ytp-prev-button").click();
            }
        }
    });
    // Add watch later link to mini guide
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

