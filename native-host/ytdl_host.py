#!/usr/bin/env python3
"""Native messaging host for the Sekhmet downloader.

Receives a single JSON message from the extension describing a download and
spawns ~/dotfiles/bin/ytdl (via ytdl_download.sh) as a DETACHED background
process — fire-and-forget. The host replies immediately and exits; the download
keeps running in its own session, writing to a per-job log file.

Message shape:
    {"id": "<video-or-playlist-id>",
     "videoType": "single" | "playlist",
     "downloadType": "music"|"audio"|"video"|"text"|"notes",
     "quality": "regular" | "best"}
"""

import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

VALID_TYPES = {"music", "audio", "video", "text", "notes"}
VALID_QUALITIES = {"regular", "best"}

SCRIPT_DIR = Path(__file__).resolve().parent
DOWNLOAD_WRAPPER = str(SCRIPT_DIR / "ytdl_download.sh")
LOG_DIR = Path.home() / ".local" / "share" / "sekhmet" / "logs"

# The detached download needs fish, yt-dlp, ffmpeg, whisper-cli (all Homebrew)
# and trash (~/dotfiles/bin). Build a minimal but sufficient PATH; HOME is set so
# ~/Cloud/ytdl and transcribe's model paths resolve under a minimal launch env.
CHILD_PATH = f"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{Path.home()}/dotfiles/bin"


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


def build_url(video_id, video_type):
    """Mirror ytdl.rb: playlists get a playlist URL, singles pass the bare id."""
    if video_type == "playlist":
        return f"https://www.youtube.com/playlist?list={video_id}"
    return video_id


def main():
    msg = read_message()
    if msg is None:
        send_message({"ok": False, "error": "no message received"})
        return

    video_id = (msg or {}).get("id")
    video_type = (msg or {}).get("videoType", "single")
    download_type = (msg or {}).get("downloadType")
    quality = (msg or {}).get("quality", "regular")

    # Validate everything before we spawn anything.
    if not video_id:
        send_message({"ok": False, "error": "missing id"})
        return
    if download_type not in VALID_TYPES:
        send_message({"ok": False, "error": f"invalid downloadType '{download_type}'"})
        return
    if quality not in VALID_QUALITIES:
        send_message({"ok": False, "error": f"invalid quality '{quality}'"})
        return

    url = build_url(video_id, video_type)

    # Strict argv ordering: flags first, then [type, url]. The id/url is always
    # the LAST positional so it never lands in bin/ytdl's flag slot; bin/ytdl
    # passes it to yt-dlp as `-- $ytid`, so a leading-dash id is safe.
    args = ["--quiet"]
    if quality == "best":
        args += ["--quality", "best"]
    args += [download_type, url]

    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        # Per-job log so concurrent downloads don't interleave into one file.
        safe_id = "".join(c if c.isalnum() or c in "-_" else "_" for c in video_id)
        log_path = LOG_DIR / f"ytdl-{download_type}-{safe_id}-{int(time.time())}.log"
        log_fd = open(log_path, "a")

        env = {
            "PATH": CHILD_PATH,
            "HOME": os.environ.get("HOME", str(Path.home())),
            # Browsers launch native hosts with a stripped env; ensure a UTF-8
            # locale so transcribe / unicode video titles don't choke.
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        }

        # Detached: own session (no SIGHUP when the host exits), stdin from
        # /dev/null, stdout/stderr to the log file — NEVER this process's real
        # stdout, which is the framed message pipe back to the browser. That
        # decoupling is what lets the download survive the browser closing the
        # pipe (no SIGPIPE) after we reply.
        proc = subprocess.Popen(
            [DOWNLOAD_WRAPPER, *args],
            stdin=subprocess.DEVNULL,
            stdout=log_fd,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
            env=env,
        )
        log_fd.close()
        send_message({"ok": True, "pid": proc.pid, "log": str(log_path)})
    except Exception as e:
        send_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
