#!/usr/bin/env bash
# Sequential merge train: merge trunk into each branch, gate, compare, --no-ff merge to trunk.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
TRUNK="${MERGE_TRAIN_TRUNK:-claude/ecstatic-hamilton-86gtwv}"
RESULTS="$ROOT/.merge-train-gates/train-log.jsonl"
if [[ -z "${MERGE_TRAIN_BASELINE:-}" ]]; then
  latest=$(ls -t "$ROOT/.merge-train-gates"/pr*/summary.txt 2>/dev/null | head -1 || true)
  BASELINE="${latest:-$ROOT/.merge-train-gates/trunk-778f460b/summary.txt}"
else
  BASELINE="$MERGE_TRAIN_BASELINE"
fi
mkdir -p "$(dirname "$RESULTS")"
touch "$RESULTS"

run_queue() {
  # PR# branch
  echo "9 exec/03.1-27"
  echo "4 exec/03.1-28"
  echo "5 exec/03.1-33"
  echo "6 exec/03.1-34"
  echo "12 exec/03.1-35"
  echo "8 exec/03.1-36"
  echo "7 exec/03.1-55"
  echo "11 exec/04-28"
  echo "15 exec/04-29"
  echo "13 exec/04-37"
  echo "18 exec/03.1-29"
  echo "21 exec/03.1-30"
  echo "17 exec/03.1-31"
  echo "16 exec/03.1-32"
  echo "20 exec/03.1-37"
  echo "19 exec/03.1-39"
  echo "22 exec/queue-hardening"
}

git fetch origin "$TRUNK"
git checkout "$TRUNK"
git pull origin "$TRUNK"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: working tree dirty; stash or commit before merge train" >&2
  exit 1
fi

# Handoff/state docs are rewritten on trunk at every pause; when they are the only
# conflicts in a trunk-into-branch merge, take trunk's copy ("theirs").
HANDOFF_DOC_RE='^(HANDOFF\.md|\.planning/STATE\.md|\.planning/HANDOFF\.json|\.planning/paused/exec-ledger\.md|\.planning/.*/\.continue-here\.md|\.planning/\.continue-here\.md)$'
resolve_handoff_conflicts() {
  local conflicted
  conflicted=$(git diff --name-only --diff-filter=U)
  [[ -n "$conflicted" ]] || return 1
  if grep -qvE "$HANDOFF_DOC_RE" <<<"$conflicted"; then
    return 1
  fi
  while IFS= read -r f; do
    git checkout --theirs -- "$f"
    git add -- "$f"
  done <<<"$conflicted"
  return 0
}

already_merged() {
  local pr="$1"
  if [[ -f "$RESULTS" ]]; then
    local line
    line=$(grep "\"pr\":${pr}," "$RESULTS" | tail -1 || true)
  if [[ -n "$line" ]] && [[ "$line" == *'"status":"merged"'* ]]; then
      return 0
    fi
  fi
  git log --oneline --grep="merge: PR #${pr} " -n 1 HEAD 2>/dev/null | grep -q .
}

while read -r pr branch; do
  [[ -z "$pr" ]] && continue
  if already_merged "$pr"; then
    echo "=== PR #$pr $branch — already merged, skip ==="
    base_summary="$ROOT/.merge-train-gates/pr${pr}/summary.txt"
    [[ -f "$base_summary" ]] && BASELINE="$base_summary"
    continue
  fi
  echo "=== PR #$pr $branch ==="
  git fetch origin "$branch" || { echo "SKIP #$pr fetch failed"; continue; }
  git checkout -B "train/${branch#exec/}" "origin/$branch"
  if ! git merge "origin/$TRUNK" -m "merge trunk into $branch for train"; then
    if resolve_handoff_conflicts; then
      git commit --no-edit -m "merge trunk into $branch for train (handoff docs from trunk)"
    else
    git merge --abort 2>/dev/null || true
    git checkout "$TRUNK"
    echo "{\"pr\":$pr,\"branch\":\"$branch\",\"status\":\"skip\",\"reason\":\"merge conflict\"}" >>"$RESULTS"
    continue
    fi
  fi
  ./scripts/ci/merge-train-gate.sh "pr${pr}" || true
  gate_fail=$(grep 'FAIL count:' "$ROOT/.merge-train-gates/pr${pr}/full.log" 2>/dev/null | tail -1 | awk '{print $NF}' || echo "?")
  cand="$ROOT/.merge-train-gates/pr${pr}/summary.txt"
  if [[ ! -f "$cand" ]]; then
    grep -A22 'LOCAL GATE SUMMARY' "$ROOT/.merge-train-gates/pr${pr}/full.log" >"$cand" || true
  fi
  if ! ./scripts/ci/merge-train-verify.sh "$pr"; then
    git checkout "$TRUNK"
    echo "{\"pr\":$pr,\"branch\":\"$branch\",\"status\":\"skip\",\"reason\":\"extra verification failed\"}" >>"$RESULTS"
    git branch -D "train/${branch#exec/}" 2>/dev/null || true
    continue
  fi
  git checkout "$TRUNK"
  if ./scripts/ci/gate-compare.sh "$BASELINE" "$cand"; then
    git merge --no-ff "train/${branch#exec/}" -m "merge: PR #${pr} ${branch}"
    sha=$(git rev-parse HEAD)
    git push origin "$TRUNK"
    BASELINE="$ROOT/.merge-train-gates/pr${pr}/summary.txt"
    echo "{\"pr\":$pr,\"branch\":\"$branch\",\"status\":\"merged\",\"sha\":\"$sha\",\"gate_fail_count\":$gate_fail}" >>"$RESULTS"
    echo "MERGED #$pr $sha"
  else
    nf="$ROOT/.merge-train-gates/pr${pr}/new-failures.txt"
    ./scripts/ci/gate-new-failures.sh "$BASELINE" "pr${pr}" >"$nf" 2>&1 || true
    new_tests=$(grep '^  TEST:' "$nf" 2>/dev/null | sed 's/^  TEST: //' | tr '\n' ';' || true)
    echo "{\"pr\":$pr,\"branch\":\"$branch\",\"status\":\"skip\",\"reason\":\"new failures vs trunk baseline\",\"gate_fail_count\":$gate_fail,\"new_failing_tests\":\"$new_tests\"}" >>"$RESULTS"
    echo "SKIP #$pr new failures vs baseline"
    cat "$nf" 2>/dev/null || true
  fi
  git branch -D "train/${branch#exec/}" 2>/dev/null || true
done < <(run_queue)