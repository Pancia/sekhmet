#!/usr/bin/env bash
set -euo pipefail

# Install the native messaging hosts for Brave/Chrome on macOS.
# Usage: ./install.sh <extension-id>
#
# To find your extension ID: brave://extensions → Sekhmet → ID field

if [ $# -lt 1 ]; then
    echo "Usage: $0 <extension-id>"
    echo ""
    echo "Find your extension ID at brave://extensions"
    exit 1
fi

EXT_ID="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Chromium-style native messaging dirs (Brave checks both its own and Chrome's).
MANIFEST_DIRS=(
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
)

# host_name | entry script | description
install_host() {
    local host_name="$1"
    local host_script="$2"
    local description="$3"

    chmod +x "$host_script"

    local manifest
    manifest=$(cat <<EOF
{
    "name": "$host_name",
    "description": "$description",
    "path": "$host_script",
    "type": "stdio",
    "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

    for dir in "${MANIFEST_DIRS[@]}"; do
        mkdir -p "$dir"
        echo "$manifest" > "$dir/$host_name.json"
        echo "Installed: $dir/$host_name.json"
    done
}

install_host "com.sekhmet.feeling_tracker" \
    "$SCRIPT_DIR/run_host.sh" \
    "Sekhmet feeling tracker file writer"

install_host "com.sekhmet.ytdl" \
    "$SCRIPT_DIR/run_ytdl_host.sh" \
    "Sekhmet downloader (spawns ~/dotfiles/bin/ytdl)"

install_host "com.sekhmet.dev_reload" \
    "$SCRIPT_DIR/run_dev_reload_host.sh" \
    "Sekhmet dev reload (forwards native-host/reload-extension)"

install_host "com.sekhmet.picker_claude" \
    "$SCRIPT_DIR/run_picker_claude_host.sh" \
    "Sekhmet element picker: asks Claude for block rules"

# The detached download wrapper isn't a host manifest entry, but must be runnable.
chmod +x "$SCRIPT_DIR/ytdl_download.sh"
chmod +x "$SCRIPT_DIR/reload-extension"

echo ""
echo "Restart Brave for changes to take effect."
