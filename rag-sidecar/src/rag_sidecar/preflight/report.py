"""Route every parse fixture with L1, L1+L2 and L1+L2+L3 and record each page's tier, preset and deciding layer (D-39).

Runs offline: the recorded range converter stands in for Docling and the recorded verdicts under `recorded/<sha>/vlm/` stand
in for the app's detect-vlm route. The report holds no timings, so the same inputs give the same bytes.

    python -m rag_sidecar.preflight.report --fixtures eval/fixtures/parse --out eval/reports/phase-03.1/parse-routing.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from rag_sidecar.contracts.queue import DetectVlmPageResult, DetectVlmResponse, JobSettingsSnapshot
from rag_sidecar.contracts.routing import (
    DocClass,
    Layer,
    PageSignal,
    PageStructureVerdict,
    ParseRoutingConfig,
    ParseTier,
    Preset,
)

if TYPE_CHECKING:
    from rag_sidecar.preflight.l2 import L2Page

LayerCombo = Literal["L1", "L1+L2", "L1+L2+L3"]
COMBO_L1: LayerCombo = "L1"
COMBO_L1_L2: LayerCombo = "L1+L2"
COMBO_L1_L2_L3: LayerCombo = "L1+L2+L3"
ALL_COMBOS: tuple[LayerCombo, ...] = (COMBO_L1, COMBO_L1_L2, COMBO_L1_L2_L3)

_REPO_ROOT = Path(__file__).resolve().parents[4]
_DEFAULT_PROFILES = _REPO_ROOT / "config" / "rag" / "processing-profiles.json"
_DEFAULT_DOC_TYPE = "general"
# The parse fixtures carry a class, not a document type; only the invoice class maps to its own processing profile.
_DOC_TYPE_BY_CLASS = {"invoice": "invoice_receipt"}
_WORKER_ID = "recorded-l3"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class RoutedPage(_Model):
    page: int = Field(ge=1)
    tier: ParseTier
    preset: Preset
    layer: Layer
    signals: list[PageSignal]


class ComboRouting(_Model):
    combo: LayerCombo
    doc_class: DocClass
    l2_pages: int = Field(ge=0)
    l3_pages: int = Field(ge=0)
    pages: list[RoutedPage]


class FixtureRouting(_Model):
    fixture_id: str
    sha256: str
    doc_type: str
    min_tier: ParseTier
    max_tier: ParseTier
    combos: list[ComboRouting]


class RoutingReport(_Model):
    probe_version: str
    routing_config_version: str
    fixtures: list[FixtureRouting]


class RecordedVlmApp:
    """Answers detect-vlm from the recorded verdicts of one fixture; a page without a recording is left out (a failed page)."""

    def __init__(self, recorded_root: Path, sha256: str) -> None:
        self._dir = recorded_root / sha256 / "vlm"
        self.calls: list[list[int]] = []

    def detect(self, pages: Sequence[tuple[int, bytes]]) -> DetectVlmResponse:
        numbers = [number for number, _blob in pages]
        self.calls.append(numbers)
        results: list[DetectVlmPageResult] = []
        for number in numbers:
            path = self._dir / f"page-{number}.json"
            if path.is_file():
                verdict = PageStructureVerdict.model_validate_json(path.read_text(encoding="utf-8"))
                results.append(DetectVlmPageResult(page=number, verdict=verdict))
        return DetectVlmResponse(worker_id=_WORKER_ID, pages=results)


def _profile_bounds(profiles_path: Path, doc_type: str) -> tuple[ParseTier, ParseTier]:
    data = json.loads(profiles_path.read_text(encoding="utf-8"))
    for profile in data["profiles"]:
        if profile["doc_type"] == doc_type:
            return profile["min_tier"], profile["max_tier"]
    raise ValueError(f"no processing profile for doc_type {doc_type!r}")


def _snapshot(doc_type: str, min_tier: ParseTier, max_tier: ParseTier, cfg: ParseRoutingConfig, *, vlm: bool) -> JobSettingsSnapshot:
    return JobSettingsSnapshot.model_validate(
        {
            "routing": "tiered",
            "cloud_allowed": vlm,
            "escalation": True,
            "progressive": False,
            "premium_max_pages_per_doc": 50,
            "premium_page_budget": 100 if vlm else 0,
            "vlm_detect": vlm,
            "profile_id": f"{doc_type}@1",
            "profile_version": 1,
            "doc_type": doc_type,
            "min_tier": min_tier,
            "max_tier": max_tier,
            "embed_mode": "sync",
            "ocr_languages": ["en"],
            "routing_config_version": cfg.version,
        }
    )


def _route_combo(
    combo: LayerCombo,
    pdf: Path,
    sha256: str,
    doc_type: str,
    bounds: tuple[ParseTier, ParseTier],
    cfg: ParseRoutingConfig,
    converter: Any,
    recorded_root: Path,
) -> ComboRouting:
    from rag_sidecar.preflight.l1 import l1_signals
    from rag_sidecar.preflight.l2 import L2Page
    from rag_sidecar.preflight.l3 import L3Page, l3_refine
    from rag_sidecar.preflight.run import run_preflight

    decided: list[L2Page] = []
    snapshot = _snapshot(doc_type, bounds[0], bounds[1], cfg, vlm=combo == COMBO_L1_L2_L3)

    if combo == COMBO_L1:
        l1_view = {page.page: page for page in l1_signals(pdf, cfg).pages}

        def hook(pages, disagreements, path, settings, routing):  # noqa: ANN001, ANN202
            # Drop what L2 concluded: every page keeps its L1 signals, as if L2 never ran.
            out = [L2Page(l1=l1_view[page.page], uncertain=l1_view[page.page].uncertain, layer="L1") for page in pages]
            decided.extend(out)
            return out

    elif combo == COMBO_L1_L2:

        def hook(pages, disagreements, path, settings, routing):  # noqa: ANN001, ANN202
            decided.extend(pages)
            return pages

    else:
        app = RecordedVlmApp(recorded_root, sha256)

        def hook(pages, disagreements, path, settings, routing):  # noqa: ANN001, ANN202
            out = l3_refine(pages, disagreements, path, settings, app, routing)
            decided.extend(out)
            return out

    output = run_preflight(pdf, snapshot, cfg, converter, hook, file_sha=sha256)
    layer_by_page = {page.page: page.layer for page in decided}
    pages = [
        RoutedPage(
            page=row.page,
            tier=row.tier,
            preset=row.preset,
            layer=layer_by_page[row.page],
            signals=list(row.signals),
        )
        for row in output.result.pages
    ]
    return ComboRouting(
        combo=combo,
        doc_class=output.result.doc_class,
        l2_pages=sum(1 for page in decided if page.l2_inspected),
        l3_pages=sum(1 for page in decided if isinstance(page, L3Page) and page.l3_examined),
        pages=pages,
    )


def _manifest(fixtures_dir: Path) -> list[dict[str, Any]]:
    data = json.loads((fixtures_dir / "manifest.json").read_text(encoding="utf-8"))
    return sorted(data["fixtures"], key=lambda row: row["id"])


def build_routing_report(
    fixtures_dir: Path,
    *,
    fixture_ids: Sequence[str] | None = None,
    combos: Sequence[LayerCombo] = ALL_COMBOS,
    routing_config: Path | None = None,
    profiles: Path | None = None,
) -> RoutingReport:
    """Route the selected fixtures (all of them by default) once per layer combination."""
    from rag_sidecar.ingest.converters import RecordedRangeConverter
    from rag_sidecar.preflight.config import load_routing_config
    from rag_sidecar.preflight.run import PROBE_VERSION

    cfg = load_routing_config(routing_config)
    profiles_path = profiles or _DEFAULT_PROFILES
    recorded_root = fixtures_dir / "recorded"
    converter = RecordedRangeConverter(recorded_root)
    # manifest paths are relative to the eval project root (eval/fixtures/parse -> eval)
    eval_root = fixtures_dir.parents[1]
    rows = _manifest(fixtures_dir)
    known = {row["id"] for row in rows}
    if fixture_ids is not None:
        missing = sorted(set(fixture_ids) - known)
        if missing:
            raise ValueError(f"unknown parse fixtures: {', '.join(missing)}")
        rows = [row for row in rows if row["id"] in set(fixture_ids)]

    fixtures: list[FixtureRouting] = []
    for row in rows:
        doc_type = _DOC_TYPE_BY_CLASS.get(row["class"], _DEFAULT_DOC_TYPE)
        bounds = _profile_bounds(profiles_path, doc_type)
        pdf = eval_root / row["pdf_path"]
        routed = [_route_combo(combo, pdf, row["sha256"], doc_type, bounds, cfg, converter, recorded_root) for combo in combos]
        fixtures.append(
            FixtureRouting(
                fixture_id=row["id"],
                sha256=row["sha256"],
                doc_type=doc_type,
                min_tier=bounds[0],
                max_tier=bounds[1],
                combos=routed,
            )
        )
    return RoutingReport(probe_version=PROBE_VERSION, routing_config_version=cfg.version, fixtures=fixtures)


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_sidecar.preflight.report", description=__doc__.splitlines()[0])
    parser.add_argument("--fixtures", type=Path, required=True, help="parse fixture directory holding manifest.json")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--fixture", action="append", dest="fixtures_only", help="route only this fixture id (repeatable)")
    parser.add_argument("--no-l2", action="store_true", help="report L1 only")
    parser.add_argument("--no-l3", action="store_true", help="leave out the L1+L2+L3 combination")
    parser.add_argument("--routing-config", type=Path, default=None)
    parser.add_argument("--profiles", type=Path, default=None)
    args = parser.parse_args(argv)

    if args.no_l2:
        combos: tuple[LayerCombo, ...] = (COMBO_L1,)
    elif args.no_l3:
        combos = (COMBO_L1, COMBO_L1_L2)
    else:
        combos = ALL_COMBOS
    fixtures_dir = args.fixtures.resolve()
    if not (fixtures_dir / "manifest.json").is_file():
        parser.error(f"missing {fixtures_dir / 'manifest.json'}")
    try:
        report = build_routing_report(
            fixtures_dir,
            fixture_ids=args.fixtures_only,
            combos=combos,
            routing_config=args.routing_config,
            profiles=args.profiles,
        )
    except ValueError as exc:
        parser.error(str(exc))
    payload = json.dumps(report.model_dump(mode="json"), sort_keys=True, ensure_ascii=False, indent=2) + "\n"
    _write_atomic(args.out, payload)
    total = sum(len(entry.combos[0].pages) for entry in report.fixtures)
    print(f"[Parse Routing] wrote {len(report.fixtures)} fixtures, {total} pages, combos {', '.join(combos)} to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
