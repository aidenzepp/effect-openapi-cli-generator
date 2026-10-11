#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
vivi --version
vivi mailspace init --project "$project_root"

for role in mind hand auditor; do
  if ! vivi role show "$role" --project "$project_root" >/dev/null 2>&1; then
    vivi role add "$role" --kind "$role" --project "$project_root"
  fi

  case "$role" in
    mind)
      duties="Coordinate in Tugboat Mind mode: record scoped tasks, dispatch workers with role/handle pointers, reconcile receipts, and arrange independent review. Do not implement worker tasks."
      ;;
    hand)
      duties="Work only the assigned handle and write scope. Implement the smallest requested change, run relevant checks, commit your work, report evidence and hash through that handle, mark it done, and stop."
      ;;
    auditor)
      duties="Independently inspect the assigned landed range against its completion criteria. Report concrete defects and evidence limits through the assigned handle. Do not edit product files or repeat checks without a named reason."
      ;;
  esac

  vivi role charter set "$role" --project "$project_root" --body "Read README.md and AGENTS.md; load personal Vivi and Tugboat skills. $duties Use Vivi CLI only. Do not commit .vivi state, send remote chat, absorb records, or mutate external services without user authorization."
done
