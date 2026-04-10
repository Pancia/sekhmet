#!/usr/bin/env bash
set -euo pipefail

# Install the native messaging host for Brave on macOS.
# Usage: ./install.sh <extension-id>
#
# To find your extension ID: brave://extensions → YouTube Enhancer → ID field

if [ $# -lt 1 ]; then
    echo "Usage: $0 <extension-id>"
    echo ""
    echo "Find your extension ID at brave://extensions"
    exit 1
fi

EXT_ID="$1"
HOST_NAME="com.ytf.feeling_tracker"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/run_host.sh"
MANIFEST_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"

MANIFEST_CONTENT=$(cat <<EOF
{
    "name": "$HOST_NAME",
    "description": "YouTube Enhancer feeling tracker file writer",
    "path": "$HOST_SCRIPT",
    "type": "stdio",
    "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

chmod +x "$HOST_SCRIPT"
mkdir -p "$MANIFEST_DIR"
echo "$MANIFEST_CONTENT" > "$MANIFEST_DIR/$HOST_NAME.json"
echo "Installed to: $MANIFEST_DIR/$HOST_NAME.json"

# Brave also checks Chrome's user-level NativeMessagingHosts directory
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$CHROME_DIR"
echo "$MANIFEST_CONTENT" > "$CHROME_DIR/$HOST_NAME.json"
echo "Installed to: $CHROME_DIR/$HOST_NAME.json"

echo ""
echo "Restart Brave for changes to take effect."
