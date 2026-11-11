#!/usr/bin/env python3
"""Native messaging host that reads a prompt file from ~/dotfiles/ai/prompts.

The prompts live on this machine, not in the extension, so they can change
without a reload and stay out of this repo. The extension names a prompt; this
host reads ~/dotfiles/ai/prompts/<name>.md fresh each time and replies with
its text.

Message shape (relayed by background.js):
    {"name": "summarize-video-public"}

Reply:
    {"ok": true, "text": "...", "path": "/Users/.../summarize-video-public.md"}
    {"ok": false, "error": "..."}

The name is a bare file stem, so a message cannot reach outside the folder.
"""

import json
import re
import struct
import sys
from pathlib import Path

PROMPTS_DIR = Path.home() / "dotfiles" / "ai" / "prompts"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
MAX_BYTES = 200_000


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    length = struct.unpack("@I", raw_length)[0]
    return json.loads(sys.stdin.buffer.read(length))


def send_message(msg):
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main():
    try:
        msg = read_message()
    except Exception as e:
        send_message({"ok": False, "error": f"bad message: {e}"})
        return
    name = (msg or {}).get("name")
    if not isinstance(name, str) or not NAME_RE.match(name):
        send_message({"ok": False, "error": f"invalid prompt name {name!r}"})
        return

    path = PROMPTS_DIR / f"{name}.md"
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        send_message({"ok": False, "error": f"no prompt file at {path}"})
        return
    except Exception as e:
        send_message({"ok": False, "error": f"could not read {path}: {e}"})
        return
    if len(data) > MAX_BYTES:
        send_message({"ok": False, "error": f"{path} is over {MAX_BYTES} bytes"})
        return

    text = data.decode("utf-8", errors="replace").strip()
    if not text:
        send_message({"ok": False, "error": f"{path} is empty"})
        return
    send_message({"ok": True, "text": text, "path": str(path)})


if __name__ == "__main__":
    main()
