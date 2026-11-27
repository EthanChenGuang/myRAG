"""Phase 6.2 decision-record tool (D-10, D-31): stub, replaced in the GREEN commit."""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
from pathlib import Path

from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.query_additions import QueryAdditionsDecisionRecord, SpeculativeTrace

EXIT_OK = 0
EXIT_STALE = 1
EXIT_INVALID = 2
SWITCH_NAMES: tuple[str, ...] = ()

__all__ = ["RagTrace", "SpeculativeTrace", "pre_retrieval_ms", "main"]


def pre_retrieval_ms(trace: RagTrace) -> float | None:
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.compare query-additions")
    parser.add_argument("--runs", nargs="*", default=[])
    parser.add_argument("--out", type=Path)
    parser.add_argument("--decision", type=Path)
    parser.add_argument("--tests", nargs="*", default=[])
    parser.add_argument("--recorded-at")
    parser.add_argument("--check", type=Path)
    args = parser.parse_args(argv)
    if args.check is not None:
        return EXIT_OK
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "report.json").write_text("{}\n", encoding="utf-8")
    (args.out / "report.md").write_text("\n", encoding="utf-8")
    record = QueryAdditionsDecisionRecord(recorded_at=datetime.now(UTC), report_hash="0" * 64, source="fixture")
    args.decision.write_text(record.model_dump_json(indent=2) + "\n", encoding="utf-8")
    return EXIT_OK
