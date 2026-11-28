"""Route parse fixtures once per candidate set of L1 thresholds, for the dev-split sweep in rag_eval.parse_gate (D-41).

Each candidate names the L1 values it changes (garbled ratio, ruling-path minimum, scanned character limit); everything else comes
from the routing file. Only the fixtures named on the command line are read, so the caller decides which split the sweep sees.

    python -m rag_sidecar.preflight.sweep --fixtures eval/fixtures/parse --fixture scan-en --candidates c.json --out routed.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from rag_sidecar.contracts.routing import ParseRoutingConfig
from rag_sidecar.preflight.config import load_routing_config
from rag_sidecar.preflight.report import ALL_COMBOS, COMBO_L1_L2, LayerCombo, build_routing_report

SWEPT = frozenset({"garbled_ratio", "min_ruling_paths", "scanned_max_chars"})


def candidate_config(base: ParseRoutingConfig, candidate: dict[str, Any]) -> ParseRoutingConfig:
    unknown = sorted(set(candidate) - SWEPT)
    if unknown:
        raise ValueError(f"the sweep changes only {', '.join(sorted(SWEPT))}; got {', '.join(unknown)}")
    data = base.model_dump(mode="json")
    data["l1"] = {**data["l1"], **candidate}
    return ParseRoutingConfig.model_validate(data)


def route_candidates(
    fixtures_dir: Path,
    fixture_ids: Sequence[str],
    candidates: Sequence[dict[str, Any]],
    combo: LayerCombo = COMBO_L1_L2,
    *,
    routing_config: Path | None = None,
) -> list[dict[str, list[dict[str, Any]]]]:
    """Per candidate, per fixture: every page's tier, preset and signals under that combination."""
    if combo not in ALL_COMBOS:
        raise ValueError(f"unknown layer combination {combo}")
    base = load_routing_config(routing_config)
    configs = [candidate_config(base, candidate) for candidate in candidates]
    out: list[dict[str, list[dict[str, Any]]]] = []
    for cfg in configs:
        report = build_routing_report(fixtures_dir, fixture_ids=list(fixture_ids), combos=(combo,), cfg=cfg)
        out.append(
            {
                fixture.fixture_id: [
                    {"page": page.page, "tier": page.tier, "preset": page.preset, "signals": list(page.signals)}
                    for page in fixture.combos[0].pages
                ]
                for fixture in report.fixtures
            }
        )
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_sidecar.preflight.sweep", description=__doc__.splitlines()[0])
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--fixture", action="append", dest="fixture_ids", required=True, help="fixture id to route (repeatable)")
    parser.add_argument("--candidates", type=Path, required=True, help="JSON list of L1 threshold sets")
    parser.add_argument("--combo", default=COMBO_L1_L2, choices=list(ALL_COMBOS))
    parser.add_argument("--routing-config", type=Path, default=None)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        candidates = json.loads(args.candidates.read_text(encoding="utf-8"))
        if not isinstance(candidates, list) or not all(isinstance(item, dict) for item in candidates):
            raise ValueError("--candidates must hold a JSON list of objects")
        routed = route_candidates(args.fixtures.resolve(), args.fixture_ids, candidates, args.combo, routing_config=args.routing_config)
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_name(f".{args.out.name}.tmp")
    tmp.write_text(json.dumps(routed, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, args.out)
    print(f"[Parse Sweep] routed {len(args.fixture_ids)} fixtures for {len(candidates)} candidates", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
