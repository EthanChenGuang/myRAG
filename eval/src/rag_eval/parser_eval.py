"""Per-tier parser metrics on the parse test set and page-tier accuracy per detection layer (D-39).

Scores the recorded outputs under `fixtures/parse/recorded/<sha>/<tier>/` against each fixture's `ParserExpected`:

- text similarity: 1 minus the character error rate after NFKC and whitespace normalisation, per page, summed over pages;
- table cell F1: micro-F1 over cells matched by row, column and normalised text (case-folded);
- reading order: the share of expected anchor pairs found in the same order;
- headings: F1 over (level, normalised text);
- seconds and cost per page from the routing cost table, with the table's source.

Page-tier accuracy reads the routing report written by `python -m rag_sidecar.preflight.report` and is report-only.
Docling JSON is read with a small reader of texts, tables and body order, so this module does not import docling.

    python -m rag_eval.parser_eval --fixtures eval/fixtures/parse --routing <routing.json> \
        --out eval/reports/phase-03.1/parser-eval.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.parse_eval import (
    PageTierAccuracy,
    ParserEvalReport,
    ParserExpected,
    TableCell,
    TierParseMetrics,
)
from rag_sidecar.contracts.routing import Layer, ParseRoutingConfig, ParseTier, Preset
from rag_sidecar.preflight.config import load_routing_config
from rag_sidecar.preflight.report import FixtureRouting, LayerCombo, RoutingReport

from rag_eval.paths import resolve_cli_path

COMBO_ORDER: tuple[LayerCombo, ...] = ("L1", "L1+L2", "L1+L2+L3")
TIERS: tuple[str, ...] = ("fast", "structured_layout", "structured_full", "structured_ocr", "premium")
_COST_TIER: dict[str, ParseTier] = {
    "fast": "fast",
    "structured_layout": "structured",
    "structured_full": "structured",
    "structured_ocr": "structured",
    "premium": "premium",
}
_TIER_RANK: dict[str, int] = {"native": 0, "fast": 1, "structured": 2, "premium": 3}
# Reading-order anchors hold the first 80 characters of each block (fixtures/parse/parse_expected.py); recorded blocks are cut
# to the same length so a faithful output scores 1.0.
ANCHOR_CHARS = 80
TEST_SET_ID = "parse-test-set"
EXCLUDED_CLASSES = frozenset({"bench"})
_TEXT_LABELS = frozenset({"text", "paragraph", "list_item"})
_HEADING_LABELS = frozenset({"title", "section_header"})
_MD_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_MD_SEPARATOR_CELL = re.compile(r"^:?-+:?$")
_BLANK_LINE = re.compile(r"\n\s*\n")
DEFAULT_OUT = "eval/reports/phase-03.1/parser-eval.json"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class BelowExpectedPage(_Model):
    fixture_id: str
    page: int = Field(ge=1)
    expected_tier: ParseTier
    routed_tier: ParseTier
    expected_preset: Preset
    routed_preset: Preset
    layer: Layer


class ComboAccuracy(_Model):
    layer_combo: LayerCombo
    pages: int = Field(ge=0)
    tier_correct: int = Field(ge=0)
    tier_accuracy: float = Field(ge=0, le=1)
    preset_correct: int = Field(ge=0)
    preset_accuracy: float = Field(ge=0, le=1)
    above_expected_tier: int = Field(ge=0)
    below_expected: list[BelowExpectedPage]


class TierCoverage(_Model):
    tier: str
    fixtures: list[str]
    pages: int = Field(ge=0)
    cost_tier: ParseTier
    cost_source: str
    cost_as_of: str


class ParserEvalDetails(_Model):
    routing_probe_version: str
    routing_config_version: str
    fixtures: list[ParserEvalReport]
    tiers: list[TierCoverage]
    page_tier: list[ComboAccuracy]
    excluded_fixtures: list[str]
    recall_at_k_measured: bool


@dataclass(frozen=True)
class MatchCounts:
    tp: int = 0
    fp: int = 0
    fn: int = 0

    def __add__(self, other: MatchCounts) -> MatchCounts:
        return MatchCounts(self.tp + other.tp, self.fp + other.fp, self.fn + other.fn)

    @property
    def precision(self) -> float:
        if self.tp + self.fp == 0:
            return 1.0 if self.fn == 0 else 0.0
        return self.tp / (self.tp + self.fp)

    @property
    def recall(self) -> float:
        if self.tp + self.fn == 0:
            return 1.0 if self.fp == 0 else 0.0
        return self.tp / (self.tp + self.fn)

    @property
    def f1(self) -> float:
        denominator = 2 * self.tp + self.fp + self.fn
        return 1.0 if denominator == 0 else 2 * self.tp / denominator


@dataclass
class PageOutput:
    blocks: list[str] = field(default_factory=list)
    headings: list[tuple[int, str]] = field(default_factory=list)
    cells: list[tuple[int, int, str]] = field(default_factory=list)


def normalize_text(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).split())


def _key(text: str) -> str:
    return normalize_text(text).casefold()


def _banded(a: str, b: str, band: int) -> int | None:
    """Edit distance when it is at most `band`, else None; only cells within `band` of the diagonal are computed."""
    n, m = len(a), len(b)
    if abs(n - m) > band:
        return None
    cap = band + 1
    previous = [j if j <= band else cap for j in range(m + 1)]
    for i in range(1, n + 1):
        current = [cap] * (m + 1)
        if i <= band:
            current[0] = i
        char = a[i - 1]
        for j in range(max(1, i - band), min(m, i + band) + 1):
            value = previous[j - 1] + (char != b[j - 1])
            if previous[j] + 1 < value:
                value = previous[j] + 1
            if current[j - 1] + 1 < value:
                value = current[j - 1] + 1
            current[j] = value if value < cap else cap
        previous = current
    distance = previous[m]
    return distance if distance <= band else None


def levenshtein(a: str, b: str) -> int:
    """Exact Levenshtein distance by banded dynamic programming, doubling the band until the answer fits inside it."""
    if a == b:
        return 0
    start = 0
    while start < len(a) and start < len(b) and a[start] == b[start]:
        start += 1
    end_a, end_b = len(a), len(b)
    while end_a > start and end_b > start and a[end_a - 1] == b[end_b - 1]:
        end_a -= 1
        end_b -= 1
    a, b = a[start:end_a], b[start:end_b]
    if not a or not b:
        return len(a) + len(b)
    band = max(16, abs(len(a) - len(b)))
    while True:
        distance = _banded(a, b, band)
        if distance is not None:
            return distance
        band *= 2


def _text_counts(reference: str, hypothesis: str) -> tuple[int, int]:
    ref = normalize_text(reference)
    hyp = normalize_text(hypothesis)
    return levenshtein(ref, hyp), len(ref)


def _similarity(edits: int, reference_chars: int) -> float:
    if reference_chars == 0:
        return 1.0 if edits == 0 else 0.0
    return max(0.0, 1.0 - edits / reference_chars)


def text_similarity(reference: str, hypothesis: str) -> float:
    """1 minus the character error rate after NFKC and whitespace normalisation, clamped to [0, 1]."""
    return _similarity(*_text_counts(reference, hypothesis))


def _cell_key(cell: TableCell | tuple[int, int, str]) -> tuple[int, int, str]:
    if isinstance(cell, TableCell):
        return cell.row, cell.col, _key(cell.text)
    row, col, text = cell
    return row, col, _key(text)


def _match(expected: Iterable[Any], predicted: Iterable[Any]) -> MatchCounts:
    want = Counter(expected)
    got = Counter(predicted)
    tp = sum((want & got).values())
    return MatchCounts(tp=tp, fp=sum(got.values()) - tp, fn=sum(want.values()) - tp)


def cell_counts(
    expected: Iterable[TableCell | tuple[int, int, str]],
    predicted: Iterable[TableCell | tuple[int, int, str]],
) -> MatchCounts:
    return _match((_cell_key(cell) for cell in expected), (_cell_key(cell) for cell in predicted))


def table_cell_f1(
    expected: Iterable[TableCell | tuple[int, int, str]],
    predicted: Iterable[TableCell | tuple[int, int, str]],
) -> float:
    """Micro-F1 over table cells matched by row, column and normalised, case-folded text."""
    return cell_counts(expected, predicted).f1


def _anchor_positions(anchors: Sequence[str], blocks: Sequence[str]) -> list[int | None]:
    keys = [_key(block) for block in blocks]
    used: set[int] = set()
    positions: list[int | None] = []
    for anchor in anchors:
        wanted = _key(anchor)
        found = None
        if wanted:
            found = next((index for index, key in enumerate(keys) if index not in used and key == wanted), None)
            if found is None:
                found = next((index for index, key in enumerate(keys) if index not in used and key.startswith(wanted)), None)
        if found is not None:
            used.add(found)
        positions.append(found)
    return positions


def _order_counts(anchors: Sequence[str], blocks: Sequence[str]) -> tuple[int, int, int]:
    positions = _anchor_positions(anchors, blocks)
    in_order = 0
    for i, first in enumerate(positions):
        if first is None:
            continue
        for second in positions[i + 1 :]:
            if second is not None and first < second:
                in_order += 1
    total = len(positions) * (len(positions) - 1) // 2
    missing = sum(1 for position in positions if position is None)
    return in_order, total, missing


def _order_score(in_order: int, total: int, missing: int) -> float:
    if total == 0:
        return 1.0 if missing == 0 else 0.0
    return in_order / total


def reading_order_score(anchors: Sequence[str], blocks: Sequence[str]) -> float:
    """Share of anchor pairs that appear in the expected order; an anchor not found breaks every pair it is in."""
    return _order_score(*_order_counts(anchors, blocks))


def heading_counts(expected: Iterable[tuple[int, str]], predicted: Iterable[tuple[int, str]]) -> MatchCounts:
    return _match(((level, _key(text)) for level, text in expected), ((level, _key(text)) for level, text in predicted))


def headings_f1(expected: Iterable[tuple[int, str]], predicted: Iterable[tuple[int, str]]) -> float:
    """F1 over (level, normalised text); a heading found at the wrong level is a miss."""
    return heading_counts(expected, predicted).f1


def read_docling_page(payload: dict[str, Any]) -> PageOutput:
    """Texts, headings and table cells of a Docling JSON export, in body order."""
    out = PageOutput()
    seen: set[str] = set()

    def resolve(ref: str) -> tuple[str, dict[str, Any]] | None:
        parts = ref.lstrip("#/").split("/")
        if len(parts) != 2 or not parts[1].isdigit():
            return None
        items = payload.get(parts[0])
        index = int(parts[1])
        if not isinstance(items, list) or index >= len(items):
            return None
        return parts[0], items[index]

    def walk(node: dict[str, Any]) -> None:
        for child in node.get("children", []):
            ref = child.get("$ref", "") if isinstance(child, dict) else ""
            if ref in seen:
                continue
            seen.add(ref)
            resolved = resolve(ref)
            if resolved is None:
                continue
            kind, item = resolved
            if item.get("content_layer", "body") != "body":
                continue
            if kind == "texts":
                label = item.get("label")
                text = item.get("text") or ""
                if label in _HEADING_LABELS:
                    level = 1 if label == "title" else int(item.get("level") or 1)
                    out.headings.append((level, text))
                    out.blocks.append(text)
                elif label in _TEXT_LABELS:
                    out.blocks.append(text)
                walk(item)
            elif kind == "tables":
                for cell in item.get("data", {}).get("table_cells", []):
                    out.cells.append((int(cell["start_row_offset_idx"]), int(cell["start_col_offset_idx"]), cell.get("text") or ""))
            elif kind == "groups":
                walk(item)

    walk(payload.get("body", {}))
    return out


def read_premium_markdown(text: str) -> PageOutput:
    """Paragraphs, `#` headings and pipe tables of premium (LlamaParse) markdown."""
    out = PageOutput()
    for chunk in _BLANK_LINE.split(text):
        lines = [line.strip() for line in chunk.splitlines() if line.strip()]
        if not lines:
            continue
        if all(line.startswith("|") for line in lines):
            row = 0
            for line in lines:
                cells = [cell.strip() for cell in line.strip("|").split("|")]
                if all(_MD_SEPARATOR_CELL.match(cell) for cell in cells):
                    continue
                out.cells.extend((row, col, cell) for col, cell in enumerate(cells))
                row += 1
            continue
        paragraph: list[str] = []
        for line in lines:
            heading = _MD_HEADING.match(line)
            if heading is None:
                paragraph.append(line)
                continue
            if paragraph:
                out.blocks.append(" ".join(paragraph))
                paragraph = []
            out.headings.append((len(heading.group(1)), heading.group(2)))
            out.blocks.append(heading.group(2))
        if paragraph:
            out.blocks.append(" ".join(paragraph))
    return out


def _tier_page_path(recorded: Path, tier: str, page: int) -> Path:
    suffix = "md" if tier == "premium" else "json"
    return recorded / tier / f"page-{page}.{suffix}"


def load_fixture_outputs(fixtures_dir: Path, sha256: str, page_count: int) -> dict[str, list[PageOutput]]:
    """Recorded outputs per tier, page by page; a tier is left out unless every page of the fixture was recorded."""
    recorded = fixtures_dir / "recorded" / sha256
    outputs: dict[str, list[PageOutput]] = {}
    for tier in TIERS:
        paths = [_tier_page_path(recorded, tier, page) for page in range(1, page_count + 1)]
        if not paths or not all(path.is_file() for path in paths):
            continue
        if tier == "premium":
            outputs[tier] = [read_premium_markdown(path.read_text(encoding="utf-8")) for path in paths]
        else:
            outputs[tier] = [read_docling_page(json.loads(path.read_text(encoding="utf-8"))) for path in paths]
    return outputs


@dataclass
class _TierCounts:
    edits: int = 0
    reference_chars: int = 0
    cells: MatchCounts = field(default_factory=MatchCounts)
    order_in: int = 0
    order_total: int = 0
    order_missing: int = 0
    headings: MatchCounts = field(default_factory=MatchCounts)
    pages: int = 0
    fixtures: list[str] = field(default_factory=list)

    def add(self, other: _TierCounts) -> None:
        self.edits += other.edits
        self.reference_chars += other.reference_chars
        self.cells = self.cells + other.cells
        self.order_in += other.order_in
        self.order_total += other.order_total
        self.order_missing += other.order_missing
        self.headings = self.headings + other.headings
        self.pages += other.pages
        self.fixtures.extend(other.fixtures)

    def metrics(self, tier: str, cfg: ParseRoutingConfig) -> TierParseMetrics:
        cost = getattr(cfg.costs.tier, _COST_TIER[tier])
        return TierParseMetrics(
            text_similarity=_similarity(self.edits, self.reference_chars),
            table_cell_f1=self.cells.f1,
            reading_order=_order_score(self.order_in, self.order_total, self.order_missing),
            headings_f1=self.headings.f1,
            s_per_page=cost.s_per_page,
            cost_per_page=cost.usd_per_page,
            # Recall@k per tier needs forced-tier retrieval runs (plan 03.1-47); not measured here.
            recall_at_k=0.0,
        )


def _fixture_counts(expected: ParserExpected, pages: list[PageOutput]) -> _TierCounts:
    counts = _TierCounts(pages=len(pages), fixtures=[expected.fixture_id])
    anchors = sorted(expected.reading_order, key=lambda anchor: anchor.order)
    for number, page in enumerate(pages, 1):
        reference = " ".join(anchor.text for anchor in anchors if anchor.page == number)
        hypothesis = " ".join(block[:ANCHOR_CHARS] for block in page.blocks)
        edits, chars = _text_counts(reference, hypothesis)
        counts.edits += edits
        counts.reference_chars += chars
    blocks = [block for page in pages for block in page.blocks]
    counts.order_in, counts.order_total, counts.order_missing = _order_counts([anchor.text for anchor in anchors], blocks)
    counts.cells = cell_counts(expected.table_cells, [cell for page in pages for cell in page.cells])
    counts.headings = heading_counts(
        [(heading.level, heading.text) for heading in expected.headings],
        [heading for page in pages for heading in page.headings],
    )
    return counts


def _scored_counts(expected: ParserExpected, outputs: dict[str, list[PageOutput]]) -> dict[str, _TierCounts]:
    page_count = len(expected.pages)
    out: dict[str, _TierCounts] = {}
    for tier in TIERS:
        pages = outputs.get(tier)
        if pages is None or len(pages) != page_count:
            continue
        out[tier] = _fixture_counts(expected, pages)
    return out


def score_fixture(
    expected: ParserExpected,
    outputs: dict[str, list[PageOutput]],
    cfg: ParseRoutingConfig,
    routing: RoutingReport | None = None,
) -> ParserEvalReport:
    """Per-tier metrics for one fixture; page-tier accuracy is filled when a routing report is given."""
    counts = _scored_counts(expected, outputs)
    accuracy = page_tier_accuracy([expected], routing)[0] if routing is not None else []
    return ParserEvalReport(
        fixture_id=expected.fixture_id,
        by_tier={tier: item.metrics(tier, cfg) for tier, item in counts.items()},
        page_tier_accuracy=accuracy,
    )


def _routed_fixture(routing: RoutingReport, fixture_id: str) -> FixtureRouting:
    for entry in routing.fixtures:
        if entry.fixture_id == fixture_id:
            return entry
    raise ValueError(f"routing report has no entry for fixture {fixture_id}")


def page_tier_accuracy(
    expected: Sequence[ParserExpected],
    routing: RoutingReport,
) -> tuple[list[PageTierAccuracy], list[ComboAccuracy]]:
    """Share of pages routed to their expected tier per layer combination, and the pages routed below it."""
    routed = [_routed_fixture(routing, item.fixture_id) for item in expected]
    present = [combo for combo in COMBO_ORDER if all(any(entry.combo == combo for entry in fixture.combos) for fixture in routed)]
    summary: list[PageTierAccuracy] = []
    details: list[ComboAccuracy] = []
    for combo in present:
        pages = tier_ok = preset_ok = above = 0
        below: list[BelowExpectedPage] = []
        for exp, fixture in zip(expected, routed, strict=True):
            combo_pages = {page.page: page for page in next(entry for entry in fixture.combos if entry.combo == combo).pages}
            if set(combo_pages) != {page.page for page in exp.pages}:
                raise ValueError(f"routing report pages for {exp.fixture_id} ({combo}) do not match the expected pages")
            for want in exp.pages:
                got = combo_pages[want.page]
                pages += 1
                tier_ok += got.tier == want.tier
                preset_ok += got.preset == want.preset
                if _TIER_RANK[got.tier] < _TIER_RANK[want.tier]:
                    below.append(
                        BelowExpectedPage(
                            fixture_id=exp.fixture_id,
                            page=want.page,
                            expected_tier=want.tier,
                            routed_tier=got.tier,
                            expected_preset=want.preset,
                            routed_preset=got.preset,
                            layer=got.layer,
                        )
                    )
                elif _TIER_RANK[got.tier] > _TIER_RANK[want.tier]:
                    above += 1
        summary.append(PageTierAccuracy(layer_combo=combo, pages_below_expected_tier=len(below)))
        details.append(
            ComboAccuracy(
                layer_combo=combo,
                pages=pages,
                tier_correct=tier_ok,
                tier_accuracy=tier_ok / pages if pages else 1.0,
                preset_correct=preset_ok,
                preset_accuracy=preset_ok / pages if pages else 1.0,
                above_expected_tier=above,
                below_expected=below,
            )
        )
    return summary, details


def _scored_fixtures(fixtures_dir: Path) -> tuple[list[tuple[dict[str, Any], ParserExpected]], list[str]]:
    manifest = json.loads((fixtures_dir / "manifest.json").read_text(encoding="utf-8"))
    scored: list[tuple[dict[str, Any], ParserExpected]] = []
    excluded: list[str] = []
    for row in sorted(manifest["fixtures"], key=lambda item: item["id"]):
        if row["class"] in EXCLUDED_CLASSES:
            excluded.append(row["id"])
            continue
        path = fixtures_dir / "expected" / f"{row['id']}.json"
        expected = ParserExpected.model_validate_json(path.read_text(encoding="utf-8"))
        if expected.fixture_id != row["id"]:
            raise ValueError(f"{path} holds fixture {expected.fixture_id}, not {row['id']}")
        if len(expected.pages) != row["page_count"]:
            raise ValueError(f"{path} lists {len(expected.pages)} pages, the manifest {row['page_count']}")
        scored.append((row, expected))
    return scored, excluded


def build_parser_eval(
    fixtures_dir: Path,
    routing: RoutingReport,
    cfg: ParseRoutingConfig,
) -> tuple[ParserEvalReport, ParserEvalDetails]:
    """The test-set report (micro-averaged over fixtures) and its details: per fixture, per tier coverage, routing misses."""
    scored, excluded = _scored_fixtures(fixtures_dir)
    totals = {tier: _TierCounts() for tier in TIERS}
    per_fixture: list[ParserEvalReport] = []
    for row, expected in scored:
        outputs = load_fixture_outputs(fixtures_dir, row["sha256"], row["page_count"])
        counts = _scored_counts(expected, outputs)
        for tier, item in counts.items():
            totals[tier].add(item)
        per_fixture.append(
            ParserEvalReport(
                fixture_id=expected.fixture_id,
                by_tier={tier: item.metrics(tier, cfg) for tier, item in counts.items()},
                page_tier_accuracy=page_tier_accuracy([expected], routing)[0],
            )
        )
    summary, combo_details = page_tier_accuracy([expected for _row, expected in scored], routing)
    covered = {tier: item for tier, item in totals.items() if item.fixtures}
    report = ParserEvalReport(
        fixture_id=TEST_SET_ID,
        by_tier={tier: item.metrics(tier, cfg) for tier, item in covered.items()},
        page_tier_accuracy=summary,
    )
    tiers = []
    for tier, item in covered.items():
        cost = getattr(cfg.costs.tier, _COST_TIER[tier])
        tiers.append(
            TierCoverage(
                tier=tier,
                fixtures=item.fixtures,
                pages=item.pages,
                cost_tier=_COST_TIER[tier],
                cost_source=cost.source,
                cost_as_of=cost.as_of,
            )
        )
    details = ParserEvalDetails(
        routing_probe_version=routing.probe_version,
        routing_config_version=routing.routing_config_version,
        fixtures=per_fixture,
        tiers=tiers,
        page_tier=combo_details,
        excluded_fixtures=excluded,
        recall_at_k_measured=False,
    )
    return report, details


def _dump(model: BaseModel) -> str:
    return json.dumps(model.model_dump(mode="json"), sort_keys=True, ensure_ascii=False, indent=2) + "\n"


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.parser_eval", description=__doc__.splitlines()[0])
    parser.add_argument("--fixtures", default="eval/fixtures/parse", help="parse fixture directory holding manifest.json")
    parser.add_argument("--routing", required=True, help="routing report from python -m rag_sidecar.preflight.report")
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--details-out", default=None, help="defaults to <out stem>-details.json beside --out")
    parser.add_argument("--routing-config", default=None, help="routing data with the cost table (default config/rag/parse-routing.json)")
    args = parser.parse_args(argv)

    fixtures_dir = resolve_cli_path(args.fixtures)
    out = resolve_cli_path(args.out)
    details_out = resolve_cli_path(args.details_out) if args.details_out else out.with_name(f"{out.stem}-details.json")
    try:
        routing = RoutingReport.model_validate_json(resolve_cli_path(args.routing).read_text(encoding="utf-8"))
    except (OSError, ValidationError) as exc:
        parser.error(f"cannot read routing report: {exc}")
    cfg = load_routing_config(resolve_cli_path(args.routing_config) if args.routing_config else None)
    try:
        report, details = build_parser_eval(fixtures_dir, routing, cfg)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    _write_atomic(out, _dump(report))
    _write_atomic(details_out, _dump(details))
    below = ", ".join(f"{item.layer_combo}={item.pages_below_expected_tier}" for item in report.page_tier_accuracy)
    print(f"[Parser Eval] {len(details.fixtures)} fixtures, tiers {', '.join(report.by_tier)}; pages below expected tier: {below}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
