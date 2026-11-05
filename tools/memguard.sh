#!/bin/bash
# memguard.sh <ceiling_mib> -- <command...>   kills the command process group when summed RSS passes the ceiling; prints peak RSS
set -u; set -m; cap=$1; shift; [ "$1" = "--" ] && shift
"$@" & pid=$!; pg=$(ps -o pgid= -p $pid | tr -d " "); peak=0
while kill -0 $pid 2>/dev/null; do
  rss=$(ps -eo pgid=,rss= 2>/dev/null | awk -v pg="$pg" "\$1==pg {s+=\$2} END {printf \"%d\", s/1024}")
  [ "${rss:-0}" -gt "$peak" ] && peak=$rss
  if [ "${rss:-0}" -gt "$cap" ]; then echo "memguard: ${rss} MiB > ${cap} MiB, killing pgid $pg" >&2; kill -TERM -- -$pg 2>/dev/null; sleep 2; kill -KILL -- -$pg 2>/dev/null; wait $pid 2>/dev/null; echo "memguard: peak_rss_mib=$peak killed=yes"; exit 137; fi
  sleep 1
done
wait $pid; rc=$?; echo "memguard: peak_rss_mib=$peak killed=no"; exit $rc
