#!/usr/bin/env bash
# Parse LOCAL GATE SUMMARY from a gate log; compare to baseline file.
set -euo pipefail
parse_summary() {
  local log="$1"
  awk '/^=== LOCAL GATE SUMMARY ===/{p=1;next} p && /^FAIL count:/{print;exit} p && NF>=2{print $1, $2}' "$log" 2>/dev/null || true
}

compare() {
  local baseline="$1" candidate="$2"
  python3 - <<'PY'
import sys
from pathlib import Path

def load(path):
    jobs = {}
    for line in Path(path).read_text().splitlines():
        if line.startswith("FAIL count:"):
            jobs["_fail_count"] = line.split()[-1]
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[0] not in ("JOB", "==="):
            jobs[parts[0]] = parts[1]
    return jobs

base = load(sys.argv[1])
cand = load(sys.argv[2])
new_fails = []
regressions = []
for k, v in cand.items():
    if k == "_fail_count":
        continue
    b = base.get(k, "SKIP")
    if v == "FAIL" and b != "FAIL":
        new_fails.append((k, b, v))
    elif v == "FAIL" and b == "FAIL":
        pass
for k in new_fails:
    regressions.append(f"{k[0]}: baseline={k[1]} candidate={k[2]}")
if regressions:
    print("NEW_FAILURES")
    for r in regressions:
        print(r)
    sys.exit(1)
print("NO_NEW_FAILURES")
print(f"baseline_fail_count={base.get('_fail_count','?')} candidate_fail_count={cand.get('_fail_count','?')}")
sys.exit(0)
PY
}

if [[ "${1:-}" == "--help" ]]; then
  echo "Usage: gate-compare.sh baseline.log candidate.log"
  exit 0
fi
compare "$1" "$2"