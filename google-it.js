function initializeGoogleIt() {
    console.log("GOOGLE IT")
    waitForElementToBeLoaded("#react-duckbar", (duckbar) => {
        console.log("GOOGLE IT: LOADED")
        document.querySelectorAll("#google-it").forEach(i => i.remove());

        const googleLink = document.createElement('a');
        googleLink.id = "google-it";
        googleLink.textContent = "Google It";
        const q = new URLSearchParams(window.location.search).get('q');
        const href = "https://google.com/search?q=";
        googleLink.href = `${href}${encodeURIComponent(q)}`;
        googleLink.style.cssText = 'color: #fff; background-color: #007bff; padding: .375rem .85rem; line-height: 1.8; border-radius: .8rem;';
        googleLink.rel = "noopener nofollow noreferrer";

        const nav = duckbar.querySelector('nav');
        nav.appendChild(googleLink);
    });
}

initializeGoogleIt()
