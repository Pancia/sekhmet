#!/usr/bin/env python3
"""Native messaging host that lets you tell Sekhmet to reload itself.

The extension connects once at startup (unpacked installs only) and keeps the
port open. This host then sits blocked on a named pipe - no polling, no CPU -
until `reload-extension` writes a line to it, and forwards that line to the
extension as {"reload": true, "files": [...]}.

It exits when the extension goes away: a reload closes the port, which closes
stdin, and the reloaded extension starts a fresh host of its own.
"""

import json
import os
import struct
import sys
import threading
from pathlib import Path

FIFO = Path.home() / ".local" / "share" / "sekhmet" / "reload.fifo"


def send_message(msg):
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def ensure_fifo():
    FIFO.parent.mkdir(parents=True, exist_ok=True)
    if FIFO.exists() and not FIFO.is_fifo():
        FIFO.unlink()
    if not FIFO.exists():
        os.mkfifo(FIFO, 0o600)


def listen():
    while True:
        # Blocks until a writer opens the pipe; EOF when it closes, then wait again.
        with open(FIFO, "r") as pipe:
            for line in pipe:
                try:
                    files = json.loads(line).get("files", [])
                except (ValueError, AttributeError):
                    files = []
                send_message({"reload": True, "files": files})


def main():
    ensure_fifo()
    threading.Thread(target=listen, daemon=True).start()

    # The extension never sends anything; this read only returns at EOF, when
    # the port has closed. os._exit because the listener is stuck in open().
    while sys.stdin.buffer.read(4096):
        pass
    os._exit(0)


if __name__ == "__main__":
    main()
