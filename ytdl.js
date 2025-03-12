function YTDL(downloadType) {
    const qp = new URLSearchParams(window.location.search);
    const fileName = (qp.get("list") && !qp.get("v")) ? qp.get("list")+".playlist" : qp.get("v")+".single";
    saveFile(fileName+`.${downloadType}.ytdl`, "ytdl gen, please ignore");
}

function initializeYTDL() {
    if (window.location.hostname !== "www.youtube.com") {
        return;
    }

    // Add watch later link to mini guide
    waitForElementToBeLoaded("ytd-mini-guide-renderer > #items", () => {
        const items = document.querySelector("ytd-mini-guide-renderer > #items");
        const watchLaterLink = document.createElement("a");
        watchLaterLink.id = "endpoint";
        watchLaterLink.tabIndex = "-1";
        watchLaterLink.className = "yt-simple-endpoint style-scope ytd-mini-guide-entry-renderer";
        watchLaterLink.title = "Library";
        watchLaterLink.href = "/playlist?list=WL";
        watchLaterLink.innerHTML = '<span style="font-size:24px">🕓</span><span class="title style-scope ytd-mini-guide-entry-renderer">Watch Later</span>';
        items.insertAdjacentElement('afterend', watchLaterLink);
    });

    // Add a single download button near avatar that opens a dialog with download options
    waitForElementToBeLoaded("#center.ytd-masthead", () => {
        waitForElementToBeLoaded("#avatar-btn", () => {
            document.querySelectorAll("#ytdl").forEach(i => i.remove());

            const ytdlContainer = document.createElement("div");

            const downloadBtn = document.createElement("a");
            downloadBtn.textContent = "📽️";
            downloadBtn.id = "ytdl";
            downloadBtn.style.color = "red";
            downloadBtn.style.fontSize = "32px";
            downloadBtn.style.cursor = "pointer";
            downloadBtn.addEventListener("click", openDownloadDialog);

            ytdlContainer.appendChild(downloadBtn);

            const endContainer = document.querySelector("#center.ytd-masthead");
            if (endContainer) {
                endContainer.prepend(ytdlContainer);
            }
        });
    });

    // Function to create and open the download dialog
    function openDownloadDialog() {
        // Create dialog backdrop
        const dialogBackdrop = document.createElement("div");
        dialogBackdrop.style.position = "fixed";
        dialogBackdrop.style.top = "0";
        dialogBackdrop.style.left = "0";
        dialogBackdrop.style.width = "100%";
        dialogBackdrop.style.height = "100%";
        dialogBackdrop.style.backgroundColor = "rgba(0, 0, 0, 0.7)";
        dialogBackdrop.style.zIndex = "9999";
        dialogBackdrop.style.display = "flex";
        dialogBackdrop.style.justifyContent = "center";
        dialogBackdrop.style.alignItems = "center";

        // Create dialog content
        const dialogContent = document.createElement("div");
        dialogContent.style.backgroundColor = "white";
        dialogContent.style.borderRadius = "8px";
        dialogContent.style.padding = "20px";
        dialogContent.style.width = "300px";
        dialogContent.style.maxWidth = "80%";

        // Create dialog title
        const dialogTitle = document.createElement("h2");
        dialogTitle.textContent = "Download Options";
        dialogTitle.style.margin = "0 0 20px 0";
        dialogTitle.style.textAlign = "center";
        dialogContent.appendChild(dialogTitle);

        // Create download options list
        const optionsList = document.createElement("ul");
        optionsList.style.listStyle = "none";
        optionsList.style.padding = "0";
        optionsList.style.margin = "0";

        // Define download options
        const options = [
            { icon: "🎵", text: "Music", type: "music" },
            { icon: "🎧", text: "Audio", type: "audio" },
            { icon: "📺", text: "Video", type: "video" },
            { icon: "💾", text: "Text",  type: "text" },
            { icon: "✏️",  text: "Notes", type: "notes" }
        ];

        // Create list items for each option
        options.forEach(option => {
            const listItem = document.createElement("li");
            listItem.style.padding = "10px";
            listItem.style.margin = "5px 0";
            listItem.style.borderRadius = "4px";
            listItem.style.cursor = "pointer";
            listItem.style.display = "flex";
            listItem.style.alignItems = "center";
            listItem.style.transition = "background-color 0.2s";

            // Hover effect
            listItem.addEventListener("mouseover", () => {
                listItem.style.backgroundColor = "#f0f0f0";
            });
            listItem.addEventListener("mouseout", () => {
                listItem.style.backgroundColor = "transparent";
            });

            // Click handler
            listItem.addEventListener("click", () => {
                YTDL(option.type);
                document.body.removeChild(dialogBackdrop);
            });

            // Icon
            const icon = document.createElement("span");
            icon.textContent = option.icon;
            icon.style.fontSize = "20px";
            icon.style.marginRight = "10px";

            // Text
            const text = document.createElement("span");
            text.textContent = option.text;
            text.style.fontSize = "16px";

            listItem.appendChild(icon);
            listItem.appendChild(text);
            optionsList.appendChild(listItem);
        });

        dialogContent.appendChild(optionsList);

        // Close button
        const closeButton = document.createElement("button");
        closeButton.textContent = "Close";
        closeButton.style.display = "block";
        closeButton.style.width = "100%";
        closeButton.style.padding = "8px";
        closeButton.style.marginTop = "15px";
        closeButton.style.border = "none";
        closeButton.style.borderRadius = "4px";
        closeButton.style.backgroundColor = "#f44336";
        closeButton.style.color = "white";
        closeButton.style.cursor = "pointer";
        closeButton.addEventListener("click", () => {
            document.body.removeChild(dialogBackdrop);
        });

        dialogContent.appendChild(closeButton);
        dialogBackdrop.appendChild(dialogContent);

        // Close dialog when clicking on backdrop
        dialogBackdrop.addEventListener("click", (event) => {
            if (event.target === dialogBackdrop) {
                document.body.removeChild(dialogBackdrop);
            }
        });

        document.body.appendChild(dialogBackdrop);
    }
}
