"""Progressive mode (D-30): a provisional fast-tier version first, then the routed version."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from rag_sidecar.contracts.queue import JobSettingsSnapshot
from rag_sidecar.contracts.routing import PreflightResult


def eligible(preflight: PreflightResult, snapshot: JobSettingsSnapshot, kind: str) -> bool:
    del preflight, snapshot, kind
    return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_sidecar.ingest.progressive")
    parser.add_argument("--cases", required=True, type=Path)
    args = parser.parse_args(argv)
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    results = [
        eligible(
            PreflightResult.model_validate(case["preflight"]),
            JobSettingsSnapshot.model_validate(case["settings"]),
            str(case["kind"]),
        )
        for case in cases
    ]
    print(json.dumps(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
