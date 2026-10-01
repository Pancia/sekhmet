#!/usr/bin/env python3
"""Native messaging host for the Sekhmet feeling tracker.

Receives JSON messages from the extension and appends them as lines
to a JSONL file. Location controlled by SEKHMET_FEELING_TRACKER_FILE env var,
defaults to ~/.local/share/sekhmet/feeling-tracker.jsonl
"""

import json
import os
import struct
import sys
from pathlib import Path

DEFAULT_PATH = Path.home() / ".local" / "share" / "sekhmet" / "feeling-tracker.jsonl"
OUTPUT_FILE = Path(os.environ.get("SEKHMET_FEELING_TRACKER_FILE", str(DEFAULT_PATH)))


def read_message():
    """Read a native messaging message from stdin."""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        return None
    length = struct.unpack("@I", raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data)


def send_message(msg):
    """Send a native messaging response to stdout."""
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main():
    msg = read_message()
    if msg is None:
        send_message({"ok": False, "error": "no message received"})
        return

    try:
        OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(OUTPUT_FILE, "a") as f:
            f.write(json.dumps(msg) + "\n")
        send_message({"ok": True, "file": str(OUTPUT_FILE)})
    except Exception as e:
        send_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
