#!/bin/sh
# Test clips for the fixtures: a 30s clip for drive.js, a 120s one for countdown.js.
# Both are ignored by git.
set -e
cd "$(dirname "$0")"
ffmpeg -y -loglevel error -f lavfi -i testsrc=size=640x360:rate=24:duration=30 -c:v libx264 -pix_fmt yuv420p -g 12 v.mp4
ffmpeg -y -loglevel error -f lavfi -i testsrc=size=640x360:rate=12:duration=120 -c:v libx264 -pix_fmt yuv420p -g 12 long.mp4
echo "made v.mp4 and long.mp4"
