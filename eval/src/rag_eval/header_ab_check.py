"""TPL-09 header A/B check (plan 03.3-26): placeholder for the RED commit."""

from __future__ import annotations

import argparse
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.header_ab_check")
    parser.add_argument("--header-on", type=Path, required=True)
    parser.add_argument("--header-off", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--population", default="real")
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "header-ab.json").write_text("{}", encoding="utf-8")
    (args.out / "header-ab.md").write_text("", encoding="utf-8")
    return 70
