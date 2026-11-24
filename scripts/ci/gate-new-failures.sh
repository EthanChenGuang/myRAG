#!/usr/bin/env bash
# Print jobs that newly FAIL vs baseline and extract failing test names from gate logs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
baseline="${1:?baseline summary}"
label="${2:?pr label e.g. pr9}"
logdir="$ROOT/.merge-train-gates/${label}"
python3 - "$baseline" "$logdir" <<'PY'
import re, sys
from pathlib import Path

def load(path):
    text = Path(path).read_text(errors="replace")
    jobs = {}
    in_s = False
    for line in text.splitlines():
        if "LOCAL GATE SUMMARY" in line:
            in_s = True
            continue
        if line.startswith("FAIL count:"):
            continue
        if not in_s:
            continue
        p = line.split()
        if len(p) >= 2 and p[1] in ("PASS", "FAIL", "SKIP"):
            jobs[p[0]] = p[1]
    return jobs

base = load(sys.argv[1])
cand_path = Path(sys.argv[2]) / "summary.txt"
if not cand_path.exists():
    cand_path = Path(sys.argv[2]) / "full.log"
cand = load(cand_path)
new_jobs = [j for j, v in cand.items() if v == "FAIL" and base.get(j) != "FAIL"]
logdir = Path(sys.argv[2])
for job in new_jobs:
    print(f"NEW_FAIL_JOB: {job}")
    log = logdir / f"local-gate-{job}.log"
    if not log.exists():
        log = Path(f"/tmp/local-gate-{job}.log")
    if not log.exists():
        continue
    text = log.read_text(errors="replace")
    names = []
    for m in re.finditer(r"not ok \d+ - (.+)", text):
        names.append(m.group(1).strip())
    for m in re.finditer(r"FAIL\s+[^\n]+\s+>\s+(.+)", text):
        names.append(m.group(1).strip())
    for m in re.finditer(r"×\s+(.+?)\s+\d+ms", text):
        names.append(m.group(1).strip())
    if not names:
        for line in text.splitlines()[-30:]:
            if "error" in line.lower() or "AssertionError" in line:
                names.append(line.strip()[:200])
    for n in dict.fromkeys(names)[:15]:
        print(f"  TEST: {n}")
PY