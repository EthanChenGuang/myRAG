#!/usr/bin/env bash
# Run local pr-smoke with isolated logs; write summary for gate-compare.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
label="${1:?usage: merge-train-gate.sh <label>}"
dir="${ROOT}/.merge-train-gates/${label}"
mkdir -p "$dir"
export GATE_LOG_DIR="$dir"
export GATE_SUMMARY_LOG="$dir/summary.txt"
cd "$ROOT"
./scripts/ci/local-pr-smoke.sh 2>&1 | tee "$dir/full.log"
if [[ ! -s "$dir/summary.txt" ]]; then
  grep -A22 'LOCAL GATE SUMMARY' "$dir/full.log" >"$dir/summary.txt" || true
fi