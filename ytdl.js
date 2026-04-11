const YTDL_QUALITY_KEY = "ytdl.videoQuality";

function getYTDLVideoQuality() {
    return sessionStorage.getItem(YTDL_QUALITY_KEY) === "best" ? "best" : "regular";
}

function setYTDLVideoQuality(q) {
    sessionStorage.setItem(YTDL_QUALITY_KEY, q === "best" ? "best" : "regular");
}

function YTDL(downloadType, opts = {}) {
    const qp = new URLSearchParams(window.location.search);
    const fileName = (qp.get("list") && !qp.get("v")) ? qp.get("list")+".playlist" : qp.get("v")+".single";

    const payload = {};
    if (downloadType === "video" && opts.quality === "best") {
        payload.quality = "best";
    }
    const contents = Object.keys(payload).length ? JSON.stringify(payload) : "";
    saveFile(fileName+`.${downloadType}.ytdl`, contents);
}

function initializeYTDL() {
    if (window.location.hostname !== "www.youtube.com") {
        return;
    }

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

    // Segmented Regular/Best toggle for the Video row
    function createQualityToggle() {
        const wrap = document.createElement("div");
        wrap.style.display = "inline-flex";
        wrap.style.border = "1px solid #ccc";
        wrap.style.borderRadius = "4px";
        wrap.style.overflow = "hidden";
        wrap.style.fontSize = "12px";
        wrap.addEventListener("click", (e) => e.stopPropagation());

        const current = getYTDLVideoQuality();
        const mkBtn = (label, value) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = label;
            b.dataset.value = value;
            b.style.border = "none";
            b.style.padding = "4px 8px";
            b.style.cursor = "pointer";
            b.style.background = value === current ? "#1976d2" : "#fff";
            b.style.color = value === current ? "#fff" : "#333";
            b.addEventListener("click", () => {
                setYTDLVideoQuality(value);
                wrap.querySelectorAll("button").forEach(btn => {
                    const active = btn.dataset.value === value;
                    btn.style.background = active ? "#1976d2" : "#fff";
                    btn.style.color = active ? "#fff" : "#333";
                });
            });
            return b;
        };

        wrap.appendChild(mkBtn("Regular", "regular"));
        wrap.appendChild(mkBtn("Best", "best"));
        return wrap;
    }

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
                if (option.type === "video") {
                    const quality = getYTDLVideoQuality();
                    const qp = new URLSearchParams(window.location.search);
                    const isPlaylist = qp.get("list") && !qp.get("v");
                    if (quality === "best" && isPlaylist) {
                        if (!window.confirm("Best quality on a full playlist can be huge. Continue?")) {
                            return;
                        }
                    }
                    YTDL("video", { quality });
                } else {
                    YTDL(option.type);
                }
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
            text.style.flex = "1";

            listItem.appendChild(icon);
            listItem.appendChild(text);

            if (option.type === "video") {
                listItem.appendChild(createQualityToggle());
            }

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
