#!/bin/bash
# Native messaging entry point for the YouTube Enhancer downloader host.
# Browsers launch native hosts with a minimal PATH, so locate python3 explicitly
# (mirrors run_host.sh).
DIR="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/env -P "/Users/anthony/.pyenv/shims:/usr/local/bin:/usr/bin:/bin" python3 "$DIR/ytdl_host.py"
