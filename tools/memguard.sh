#!/bin/bash
# memguard.sh <ceiling_mib> -- <command...>   kills the command's process tree when its summed RSS passes the ceiling (exit 137)
# and again whenever the guard exits (signal, timeout, normal end), so nothing outlives it; prints peak RSS
set -u; cap=$1; shift; [ "$1" = "--" ] && shift
set -m; "$@" & pid=$!; set +m
pg=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d " ")
[ "$pg" = "$pid" ] || pg=0 # setpgid refused (EPERM under some harnesses): track the tree by parent pid alone
known=" $pid " tree="" rss=0 peak=0 killed=no tick=""

scan() { # tree := live members (descendants of the command, its own group, known members orphaned to init); rss := their sum in MiB
  local out p
  out=$(ps -Ao pid=,ppid=,pgid=,rss=,stat= 2>/dev/null | awk -v root="$pid" -v pg="$pg" -v self="$$" -v known="$known" '
    $5 !~ /^Z/ { pp[$1] = $2; gp[$1] = $3; kb[$1] = $4 }
    END {
      n = split(known, k, " "); for (i = 1; i <= n; i++) kn[k[i]] = 1
      if (root in pp) member[root] = 1
      do {
        grew = 0
        for (p in pp)
          if (!(p in member) && p != self && ((pp[p] in member) || (pg > 0 && gp[p] == pg) || ((p in kn) && pp[p] == 1))) { member[p] = 1; grew = 1 }
      } while (grew)
      s = 0; list = ""; for (p in member) { s += kb[p]; list = list " " p }
      printf "%d%s\n", s / 1024, list
    }')
  rss=${out%% *}; tree=${out#"$rss"}; rss=${rss:-0}
  for p in $tree; do case $known in *" $p "*) ;; *) known="$known$p " ;; esac; done
}

reap() { # TERM the tree, give it up to 2 s, then KILL what is left
  local _
  scan; [ -n "$tree" ] || return 0
  kill -TERM $tree 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do sleep 0.2; scan; [ -n "$tree" ] || return 0; done
  kill -KILL $tree 2>/dev/null
}

finish() { # EXIT trap: runs once however the guard ends; the exit status passed to exit is kept
  trap - EXIT INT TERM HUP
  [ -n "$tick" ] && kill "$tick" 2>/dev/null
  reap; wait "$pid" 2>/dev/null
  echo "memguard: peak_rss_mib=$peak killed=$killed"
}
trap finish EXIT
trap 'killed=signal; exit 129' HUP; trap 'killed=signal; exit 130' INT; trap 'killed=signal; exit 143' TERM

while kill -0 "$pid" 2>/dev/null; do
  scan; [ "$rss" -gt "$peak" ] && peak=$rss
  if [ "$rss" -gt "$cap" ]; then echo "memguard: ${rss} MiB > ${cap} MiB, killing the process tree of $pid" >&2; killed=yes; exit 137; fi
  sleep 1 & tick=$!; wait "$tick"; tick=""
done
wait "$pid"; exit $?
