#!/usr/bin/env bash
# Sequential merge train: merge trunk into each branch, gate, compare, --no-ff merge to trunk.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
TRUNK="${MERGE_TRAIN_TRUNK:-claude/ecstatic-hamilton-86gtwv}"
RESULTS="$ROOT/.merge-train-gates/train-log.jsonl"
BASELINE="${MERGE_TRAIN_BASELINE:-$ROOT/.merge-train-gates/trunk-778f460b/summary.txt}"

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

while read -r pr branch; do
  [[ -z "$pr" ]] && continue
  echo "=== PR #$pr $branch ==="
  git fetch origin "$branch" || { echo "SKIP #$pr fetch failed"; continue; }
  git checkout -B "train/${branch#exec/}" "origin/$branch"
  if ! git merge "origin/$TRUNK" -m "merge trunk into $branch for train"; then
    git merge --abort 2>/dev/null || true
    git checkout "$TRUNK"
    echo "{\"pr\":$pr,\"branch\":\"$branch\",\"status\":\"skip\",\"reason\":\"merge conflict\"}" >>"$RESULTS"
    continue
  fi
  ./scripts/ci/merge-train-gate.sh "pr${pr}" || true
  gate_fail=$(grep 'FAIL count:' "$ROOT/.merge-train-gates/pr${pr}/full.log" 2>/dev/null | tail -1 | awk '{print $NF}' || echo "?")
  cand="$ROOT/.merge-train-gates/pr${pr}/summary.txt"
  if [[ ! -f "$cand" ]]; then
    grep -A22 'LOCAL GATE SUMMARY' "$ROOT/.merge-train-gates/pr${pr}/full.log" >"$cand" || true
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
    echo "{\"pr\":$pr,\"branch\":\"$branch\",\"status\":\"skip\",\"reason\":\"new failures vs trunk baseline\",\"gate_fail_count\":$gate_fail}" >>"$RESULTS"
    echo "SKIP #$pr new failures vs baseline"
  fi
  git branch -D "train/${branch#exec/}" 2>/dev/null || true
done < <(run_queue)