#!/usr/bin/env bash
# Detached download task spawned by ytdl_host.py. Args: [--quality best] <type> <url>
#
# stdout/stderr are redirected to a per-job log file by the host; this script
# must never assume a terminal. Completion/failure notification is handled by
# bin/ytdl itself (--notify, via terminal-notifier) so it works reliably from
# this detached, browser-spawned process.

export HOME="${HOME:-/Users/anthony}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/dotfiles/bin"

# $@ already includes --quiet (prepended by ytdl_host.py); don't double it.
exec "$HOME/dotfiles/bin/ytdl" --notify "$@"
