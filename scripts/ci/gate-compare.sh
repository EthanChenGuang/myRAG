#!/usr/bin/env bash
# Parse LOCAL GATE SUMMARY from a gate log; compare to baseline file.
set -euo pipefail
compare() {
  local baseline="$1" candidate="$2"
  python3 - "$baseline" "$candidate" <<'PY'
import sys
from pathlib import Path

def load(path):
    text = Path(path).read_text(errors="replace")
    if "LOCAL GATE SUMMARY" not in text and "FAIL count" not in text:
        tail = text.splitlines()[-40:]
        text = "\n".join(tail)
    jobs = {}
    in_summary = False
    for line in text.splitlines():
        if "LOCAL GATE SUMMARY" in line:
            in_summary = True
            continue
        if line.startswith("FAIL count:"):
            jobs["_fail_count"] = line.split()[-1]
            continue
        if not in_summary:
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[0] not in ("JOB",) and parts[1] in ("PASS", "FAIL", "SKIP"):
            jobs[parts[0]] = parts[1]
    return jobs

base = load(sys.argv[1])
cand = load(sys.argv[2])
if not base or "_fail_count" not in base and len(base) < 3:
    print(f"BAD_BASELINE: {sys.argv[1]}", file=sys.stderr)
    sys.exit(2)
if not cand or len(cand) < 3:
    print(f"BAD_CANDIDATE: {sys.argv[2]}", file=sys.stderr)
    sys.exit(2)
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