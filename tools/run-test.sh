#!/bin/bash
# run-test.sh <test-file...>   Bun pin check, optional prepare:runtime, then bun --smol test under memguard; fails on zero tests
set -u
[ "$#" -ge 1 ] || { echo "usage: tools/run-test.sh <test-file...>" >&2; exit 2; }
root=$(cd "$(dirname "$0")/.." && pwd); cd "$root" || exit 2
bun tools/check-bun.ts || exit $?
bun run --if-present prepare:runtime || exit $?
files=(); for f in "$@"; do case "$f" in /*|./*) files+=("$f");; *) files+=("./$f");; esac; done
start=$SECONDS
out=$(tools/memguard.sh "${MEMGUARD_MIB:-4096}" -- bun --smol test "${files[@]}" 2>&1); rc=$?
printf '%s\n' "$out"; echo "run-test: wall_s=$((SECONDS - start))"
[ "$rc" -eq 0 ] || exit "$rc"
n=$(printf '%s\n' "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests\{0,1\}.*/\1/p' | tail -1)
[ "${n:-0}" -ge 1 ] || { echo "run-test: no tests ran" >&2; exit 1; }
