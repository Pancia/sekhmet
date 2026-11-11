#!/bin/bash
# Runs one reload scenario in a throwaway headless Brave, under a memory guard.
# Usage: guard.sh <scenario> <outdir>     scenario: button | self | mini-self
#        HEADED=1 guard.sh ...            a normal Brave window, with its GPU,
#                                         instead of headless
#
# This script owns Brave, not the node driver. The driver only talks to Brave
# over the debugging port. That way a driver that crashes, hangs or exits early
# cannot leave Brave running (the leak that cost 10-20 GB of swap once). A
# separate watchdog kills Brave if this script itself dies without cleaning up.
#
# Brave is killed - the whole process tree - on the first of:
#   - its processes together pass MAX_RSS_MB of resident memory, or
#     MAX_FOOTPRINT_MB of real footprint (which counts compressed memory too,
#     sampled every few seconds because footprint is slow)
#   - system swap grows more than MAX_SWAP_GROWTH_MB past the starting value
#   - after the reload: the compressor's RAM grows more than
#     MAX_COMPRESSOR_GROWTH_MB, the memory stored in it more than
#     MAX_STORED_GROWTH_MB, or Brave's footprint more than
#     MAX_FOOTPRINT_GROWTH_MB - all measured from the moment of the reload,
#     because loading YouTube in a window alone moves the first two by 1-2 GB
#   - memory the kernel can still give out falls below MIN_LEVEL_DURING percent
#   - DEADLINE_S seconds pass (HARD_DEADLINE_S for the watchdog)
#   - the driver exits, or this script is interrupted or exits for any reason
# It refuses to start if memory or disk is already short.
#
# Safety review: .cc/reports/reload-test-safety-review.md
set -u

SCENARIO="${1:?scenario: button | self | mini-self | button-tabs | self-tabs | devreload-tabs | devreload-sleeping-tabs | button-toast-tabs | devreload-toast-tabs | guarded-tabs | guarded-runaway | guarded-wake | guarded-orphan}"
OUT="${2:?outdir}"
case "$SCENARIO" in button|self|mini-self|button-tabs|self-tabs|devreload-tabs|devreload-sleeping-tabs|button-toast-tabs|devreload-toast-tabs|guarded-tabs|guarded-runaway|guarded-wake|guarded-orphan) ;; *) echo "GUARD: unknown scenario '$SCENARIO'"; exit 2 ;; esac
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../../.." && pwd -P)"
BUNDLE="/Applications/Brave Browser.app/"
BRAVE="${BUNDLE}Contents/MacOS/Brave Browser"
PORT=9341

MAX_RSS_MB=1500
# Summed resident memory counts the shared framework once per process, so a
# YouTube tab alone pushes it past 1.5 GB. The footprint trip stays at 2.5 GB.
case "$SCENARIO" in *-tabs|guarded-runaway|guarded-wake|guarded-orphan) MAX_RSS_MB=3000 ;; esac
MAX_SWAP_GROWTH_MB=512
MAX_COMPRESSOR_GROWTH_MB=1024
# System-wide, so other apps move it too; the footprint trip is the one that
# is about this Brave. Raised from 2048 after a run tripped on it while this
# Brave sat flat at 550 MB.
MAX_STORED_GROWTH_MB=3072
MAX_FOOTPRINT_MB=2500
MAX_FOOTPRINT_GROWTH_MB=1500
MIN_AVAILABLE_PCT=25
MIN_LEVEL_DURING=20
MIN_FREE_DISK_GB=5
DEADLINE_S=75
HARD_DEADLINE_S=120
TICK=0.5

BRAVE_PID=""
DRIVER_PID=""
WATCHDOG_PID=""
SAMPLER_PID=""
TOKEN=""
ROOT=""
CLEANED=""
PAGESIZE=$(sysctl -n hw.pagesize)

# Preflight, before anything exists that cleanup would have to undo.
avail=$(sysctl -n kern.memorystatus_level)
if [ "$avail" -lt "$MIN_AVAILABLE_PCT" ]; then
    echo "GUARD: only ${avail}% memory available (need ${MIN_AVAILABLE_PCT}%), not starting"; exit 2
fi
free_gb=$(df -g /System/Volumes/Data | awk 'NR==2 {print $4}')
if [ "$free_gb" -lt "$MIN_FREE_DISK_GB" ]; then
    echo "GUARD: only ${free_gb} GB disk free (need ${MIN_FREE_DISK_GB}), not starting"; exit 2
fi
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "GUARD: port $PORT is in use, not starting"; exit 2
fi
if pgrep -f "sekhmet-reload-test\." >/dev/null; then
    echo "GUARD: a previous test's processes are still alive, not starting:"
    pgrep -fl "sekhmet-reload-test\."; exit 2
fi

# One validated temp root. Every name match uses its token, so an empty or odd
# value must stop the script here, before the trap exists: an empty match
# string matches every process you own.
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/sekhmet-reload-test.XXXXXX")" || { echo "GUARD: mktemp failed"; exit 2; }
ROOT="$(cd "$ROOT" && pwd -P)" || { echo "GUARD: temp dir vanished"; exit 2; }
TOKEN="${ROOT##*/}"
case "$TOKEN" in sekhmet-reload-test.??????) ;; *) echo "GUARD: bad temp dir '$ROOT'"; exit 2 ;; esac
PROFILE="$ROOT/profile"
EXT="$ROOT/ext"
mkdir "$PROFILE" || { rm -rf "$ROOT"; exit 2; }

# The extension under test, copied so the browser never sees the repo.
if [ "$SCENARIO" = "mini-self" ]; then
    cp -R "$HERE/mini-ext" "$EXT"
else
    rsync -a --exclude .git --exclude .cc --exclude node_modules --exclude yte.xpi "$REPO/" "$EXT/"
fi || { rm -rf "$ROOT"; exit 2; }
# The copy only: put dev-reload.js back into its background scripts, as it was
# during the incidents. The repo's manifest is not touched.
if [ "${SCENARIO#devreload}" != "$SCENARIO" ] || [ "${SCENARIO#guarded}" != "$SCENARIO" ]; then
    sed -i '' 's#"scripts": \["polyfill.js", "background.js"\]#"scripts": ["polyfill.js", "background.js", "dev-reload.js"]#' "$EXT/manifest.json"
    grep -q '"dev-reload.js"' "$EXT/manifest.json" || { echo "GUARD: could not add dev-reload.js to the copy"; rm -rf "$ROOT"; exit 2; }
fi

mkdir -p "$OUT"
LOG="$OUT/$SCENARIO.timeline.csv"
FOOT="$ROOT/footprint"
DRIVER_LOG="$OUT/$SCENARIO.driver.log"

swap_mb() { sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/' | cut -d. -f1; }
comp_mb() {   # prints "<stored_mb> <occupied_mb>"
    vm_stat | awk -v ps="$PAGESIZE" '/stored in compressor/ {s=$NF} /occupied by compressor/ {o=$NF}
        END { gsub(/\./, "", s); gsub(/\./, "", o); print int(s*ps/1048576), int(o*ps/1048576) }'
}

# Brave executables that belong to this test: the launched pid, its process
# group, anything naming the token (crashpad has its own group and parent 1),
# and their Brave descendants. The token goes through ENVIRON so awk's own
# command line does not contain it, and only Brave executables can match.
brave_pids() {
    [ -n "$BRAVE_PID" ] && [ -n "$TOKEN" ] || return 0
    ps -axo pid=,ppid=,pgid=,command= | TOKEN="$TOKEN" BUNDLE="$BUNDLE" awk -v root="$BRAVE_PID" '
        { pid[NR]=$1; ppid[NR]=$2; pgid[NR]=$3; line[NR]=$0
          cmd=$0; sub(/^ *[0-9]+ +[0-9]+ +[0-9]+ /, "", cmd); brave[NR]=(index(cmd, ENVIRON["BUNDLE"])==1) }
        END {
            if (ENVIRON["TOKEN"] == "") exit 1
            for (i=1; i<=NR; i++) if (brave[i] && (pid[i]==root || pgid[i]==root || index(line[i], ENVIRON["TOKEN"]))) mine[pid[i]]=1
            changed=1
            while (changed) { changed=0
                for (i=1; i<=NR; i++) if (brave[i] && !(pid[i] in mine) && (ppid[i] in mine)) { mine[pid[i]]=1; changed=1 } }
            for (p in mine) print p
        }'
}

rss_mb() {
    local pids
    pids=$(brave_pids | paste -sd, -)
    [ -n "$pids" ] || { echo 0; return; }
    ps -o rss= -p "$pids" 2>/dev/null | awk '{ s += $1 } END { print int(s / 1024) }'
}

kill_brave() {
    local pids
    [ -n "$DRIVER_PID" ] && kill -KILL "$DRIVER_PID" 2>/dev/null
    [ -n "$SAMPLER_PID" ] && kill -KILL "$SAMPLER_PID" 2>/dev/null
    pids=$(brave_pids)
    [ -n "$BRAVE_PID" ] && kill -KILL -"$BRAVE_PID" 2>/dev/null
    [ -n "$pids" ] && kill -KILL $pids 2>/dev/null
}

cleanup() {
    trap '' INT TERM HUP      # never stop half way
    trap - EXIT
    [ -n "$CLEANED" ] && return 0
    CLEANED=1
    kill_brave
    sleep 1
    local left=""
    [ -n "$BRAVE_PID" ] && left=$(pgrep -g "$BRAVE_PID")
    [ -n "$TOKEN" ] && left="$left $(pgrep -f "^/Applications/Brave Browser\.app/.*$TOKEN")"
    left=$(echo $left)
    if [ -n "$left" ]; then
        echo "GUARD: still alive after kill, killing again: $left"
        kill -KILL $left 2>/dev/null
    else
        echo "GUARD: no test process left"
    fi
    # New Brave processes that no match could tie to this test (an untagged
    # crashpad would be one). Reported only: you may have started your own Brave.
    local new
    new=$(comm -13 <(echo "$PRE_BRAVE") <(pgrep -f '^/Applications/Brave Browser\.app/' | sort))
    [ -n "$new" ] && echo "GUARD: new Brave processes still alive (not killed, check them): $(echo $new)"
    [ -n "$WATCHDOG_PID" ] && kill -KILL -"$WATCHDOG_PID" 2>/dev/null
    case "$ROOT" in */sekhmet-reload-test.??????) rm -rf "$ROOT" ;; esac
}
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP
trap cleanup EXIT

PRE_BRAVE=$(pgrep -f '^/Applications/Brave Browser\.app/' | sort)
SWAP0=$(swap_mb)
read STORED0 OCC0 <<< "$(comp_mb)"
echo "GUARD: start - ${avail}% available, ${free_gb} GB disk free, swap ${SWAP0} MB, compressor ${OCC0} MB holding ${STORED0} MB"

# Headless unless HEADED=1. A window brings the GPU process back, as in your
# own Brave; it stays in the same process group as everything else.
MODE="--headless=new --disable-gpu"
[ "${HEADED:-}" = 1 ] && MODE="--new-window"

# Own process group (set -m), so one kill reaches every child that stays in it.
# nice, which execs Brave, so the guard's own checks get CPU first.
set -m
nice -n 10 "$BRAVE" $MODE --no-first-run --no-default-browser-check \
    --disable-crash-reporter --disable-breakpad --use-mock-keychain \
    --disable-background-networking --disable-component-update --disable-brave-update --mute-audio \
    --remote-debugging-port=$PORT --enable-unsafe-extension-debugging \
    --user-data-dir="$PROFILE" about:blank </dev/null >/dev/null 2>&1 &
BRAVE_PID=$!

# The watchdog: kills Brave if this script is gone (SIGKILL, a hang it never
# returns from, Ctrl-Z) or at the hard deadline, whichever comes first.
GUARD_PID=$$
( trap '' INT TERM HUP
  end=$(( $(date +%s) + HARD_DEADLINE_S ))
  while kill -0 "$GUARD_PID" 2>/dev/null && [ "$(date +%s)" -lt "$end" ]; do sleep 1; done
  kill -KILL -"$BRAVE_PID" 2>/dev/null
  pkill -KILL -f "^/Applications/Brave Browser\.app/.*$TOKEN" 2>/dev/null
) </dev/null >/dev/null 2>&1 &
WATCHDOG_PID=$!
set +m

# Footprint sampler: this Brave's processes totalled into $FOOT, one MB figure
# per line. One footprint call over all of them takes about a quarter second,
# so it runs beside the loop. It prints "Summary Footprint" for several pids
# and only "Footprint" for one. In this script's group: cleanup kills it by pid.
echo 0 > "$FOOT"
( while kill -0 "$GUARD_PID" 2>/dev/null; do
      pids=$(brave_pids)
      if [ -n "$pids" ]; then
          footprint --noCategories -f bytes $pids 2>/dev/null |
              awk '/^Summary Footprint:/ { s=$3 } /Footprint: [0-9]+ B/ && !f { for (i=1;i<=NF;i++) if ($i=="Footprint:") f=$(i+1) }
                   END { print int((s ? s : f) / 1048576) }' >> "$FOOT"
      fi
      sleep 1
  done ) </dev/null >/dev/null 2>&1 &
SAMPLER_PID=$!

# The token lets native-host/reload-guarded refuse any Brave but this one.
RELOAD_EXPECT="$TOKEN" node "$HERE/drive.mjs" "$SCENARIO" "$PORT" "$EXT" >"$DRIVER_LOG" 2>&1 </dev/null &
DRIVER_PID=$!

echo "t_s,brave_rss_mb,brave_footprint_mb,swap_growth_mb,compressor_growth_mb,stored_growth_mb,memory_level_pct" > "$LOG"
start=$(date +%s); peak=0; fpeak=0; reason="driver finished"
RELOADED=""; FP0=0
while kill -0 "$DRIVER_PID" 2>/dev/null; do
    t=$(( $(date +%s) - start ))
    rss=$(rss_mb)
    dswap=$(( $(swap_mb) - SWAP0 ))
    read stored occ <<< "$(comp_mb)"
    dstored=$(( stored - STORED0 )); dcomp=$(( occ - OCC0 ))
    lvl=$(sysctl -n kern.memorystatus_level)
    fp=$(tail -1 "$FOOT"); fp=${fp:-0}
    # Rebaseline the system-wide figures at the reload; see the header.
    if [ -z "$RELOADED" ] && grep -q '^reload' "$DRIVER_LOG" 2>/dev/null; then
        RELOADED=$t; FP0=$fp; STORED0=$stored; OCC0=$occ; dstored=0; dcomp=0
        echo "# reload at ${t}s: baselines reset" >> "$LOG"
    fi
    [ -n "$RELOADED" ] || { dstored=0; dcomp=0; }
    [ "$fp" -gt "$fpeak" ] && fpeak=$fp
    echo "$t,$rss,$fp,$dswap,$dcomp,$dstored,$lvl" >> "$LOG"
    [ "$rss" -gt "$peak" ] && peak=$rss
    if   [ "$rss" -gt "$MAX_RSS_MB" ]; then reason="TRIPPED: Brave resident memory ${rss} MB"; break
    elif [ "$fp" -gt "$MAX_FOOTPRINT_MB" ]; then reason="TRIPPED: Brave footprint ${fp} MB"; break
    elif [ -n "$RELOADED" ] && [ $(( fp - FP0 )) -gt "$MAX_FOOTPRINT_GROWTH_MB" ]; then reason="TRIPPED: Brave footprint grew $(( fp - FP0 )) MB after the reload"; break
    elif [ "$dswap" -gt "$MAX_SWAP_GROWTH_MB" ]; then reason="TRIPPED: swap grew ${dswap} MB"; break
    elif [ "$dcomp" -gt "$MAX_COMPRESSOR_GROWTH_MB" ]; then reason="TRIPPED: compressor RAM grew ${dcomp} MB"; break
    elif [ "$dstored" -gt "$MAX_STORED_GROWTH_MB" ]; then reason="TRIPPED: compressed memory grew ${dstored} MB"; break
    elif [ "$lvl" -lt "$MIN_LEVEL_DURING" ]; then reason="TRIPPED: memory level ${lvl}%"; break
    elif [ "$t" -ge "$DEADLINE_S" ]; then reason="TRIPPED: deadline ${DEADLINE_S}s"; break
    fi
    sleep "$TICK"
done

# Kill first, report after.
cleanup
echo "GUARD: $SCENARIO - $reason - peak Brave memory: resident ${peak} MB, footprint ${fpeak} MB"
cat "$DRIVER_LOG"
case "$reason" in TRIPPED*) exit 3 ;; esac
exit 0
