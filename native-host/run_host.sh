#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"

CONFIG="$HOME/.config/youtube-enhancer/config.json"
if [ -f "$CONFIG" ]; then
  YTF_FEELING_TRACKER_FILE="$(python3 -c "import json,sys,os;v=json.load(sys.stdin).get('feeling_tracker_file','');print(os.path.expanduser(v))" < "$CONFIG")"
fi

export YTF_FEELING_TRACKER_FILE="${YTF_FEELING_TRACKER_FILE:-${XDG_DATA_HOME:-$HOME/.local/share}/youtube-enhancer/feeling-tracker.jsonl}"
exec /usr/bin/env -P "/Users/anthony/.pyenv/shims:/usr/local/bin:/usr/bin:/bin" python3 "$DIR/feeling_tracker_host.py"
