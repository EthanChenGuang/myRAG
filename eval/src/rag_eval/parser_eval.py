"""Per-tier parser metrics on the parse test set and page-tier accuracy per detection layer (D-39).

Scores the recorded outputs under `fixtures/parse/recorded/<sha>/<tier>/` against each fixture's `ParserExpected`:

- text similarity: 1 minus the character error rate after NFKC and whitespace normalisation, per page, summed over pages;
- table cell F1: micro-F1 over cells matched by row, column and normalised text (case-folded);
- reading order: the share of expected anchor pairs found in the same order;
- headings: F1 over (level, normalised text);
- seconds and cost per page from the routing cost table, with the table's source.

Page-tier accuracy reads the routing report written by `python -m rag_sidecar.preflight.report` and is report-only.
Recall@k per tier (03.1-47) is Recall@5 of the golden items linked to each fixture (tag parse_fixture:<id>), read from the
ingest-mode runs that pinned every page to one tier (`npm run test-rag -- --fixture-mode ingest --force-tier <tier>`).
Docling JSON is read with a small reader of texts, tables and body order, so this module does not import docling.

    python -m rag_eval.parser_eval --fixtures eval/fixtures/parse --routing <routing.json> \
        --out eval/reports/phase-03.1/parser-eval.json \
        --recall-runs fast=eval/out/tier-fast structured=eval/out/tier-structured premium=eval/out/tier-premium
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.parse_eval import (
    PageTierAccuracy,
    ParserEvalReport,
    ParserExpected,
    TableCell,
    TierParseMetrics,
)
from rag_sidecar.contracts.routing import Layer, ParseRoutingConfig, ParseTier, Preset
from rag_sidecar.contracts.report import ItemResult
from rag_sidecar.preflight.config import load_routing_config
from rag_sidecar.preflight.report import FixtureRouting, LayerCombo, RoutingReport

from rag_eval.paths import REPO_ROOT, resolve_cli_path

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
# Recall@k per tier (D-40, SC6): Recall@5 of the golden items linked to a parse fixture (tag parse_fixture:<id>), read from the
# ingest-mode run that pinned every page to that tier. Each structured preset is scored from the forced structured run.
RECALL_METRIC = "recall_at_5"
FORCED_TIERS: tuple[str, ...] = ("fast", "structured", "premium")
_FORCED_TIER: dict[str, str] = {
    "fast": "fast",
    "structured_layout": "structured",
    "structured_full": "structured",
    "structured_ocr": "structured",
    "premium": "premium",
}
LINK_TAG = "parse_fixture:"
ForcedTier = Literal["fast", "structured", "premium"]


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


class RecallRun(_Model):
    """One forced-tier ingest run (`npm run test-rag -- --fixture-mode ingest --force-tier <tier>`) the recall was read from."""

    tier: ForcedTier
    run_dir: str
    run_id: str
    corpus_sha256: str | None
    linked_items: int = Field(ge=0)


class ClassRecall(_Model):
    tier: ForcedTier
    parse_class: str
    fixtures: list[str]
    items: int = Field(ge=0)
    recall_at_k: float = Field(ge=0, le=1)


class ParserEvalDetails(_Model):
    routing_probe_version: str
    routing_config_version: str
    fixtures: list[ParserEvalReport]
    tiers: list[TierCoverage]
    page_tier: list[ComboAccuracy]
    excluded_fixtures: list[str]
    recall_at_k_measured: bool
    recall_metric: str = RECALL_METRIC
    recall_runs: list[RecallRun] = Field(default_factory=list)
    recall_by_class: list[ClassRecall] = Field(default_factory=list)


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

    def metrics(self, tier: str, cfg: ParseRoutingConfig, recall_at_k: float = 0.0) -> TierParseMetrics:
        cost = getattr(cfg.costs.tier, _COST_TIER[tier])
        return TierParseMetrics(
            text_similarity=_similarity(self.edits, self.reference_chars),
            table_cell_f1=self.cells.f1,
            reading_order=_order_score(self.order_in, self.order_total, self.order_missing),
            headings_f1=self.headings.f1,
            s_per_page=cost.s_per_page,
            cost_per_page=cost.usd_per_page,
            # From the forced-tier ingest runs (--recall-runs); 0.0 when that tier's run was not given.
            recall_at_k=recall_at_k,
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


def _linked_fixture(item: GoldenItem) -> str | None:
    return next((tag[len(LINK_TAG) :] for tag in item.tags if tag.startswith(LINK_TAG)), None)


def load_recall_run(tier: str, run_dir: Path, fixture_ids: Iterable[str]) -> tuple[RecallRun, dict[str, list[float]]]:
    """Recall@5 of every answerable golden item linked to a scored fixture, by fixture, from one run-smoke output directory.

    The run's own golden.merged.jsonl says which items are linked; report.json holds their results. A linked item without a
    result is an error, so a run on another golden file cannot pass for this one.
    """
    if tier not in FORCED_TIERS:
        raise ValueError(f"recall run tier must be one of {', '.join(FORCED_TIERS)}, got {tier}")
    wanted = set(fixture_ids)
    golden_lines = (run_dir / "golden.merged.jsonl").read_text(encoding="utf-8").splitlines()
    linked: dict[str, str] = {}
    for line in golden_lines:
        if not line.strip():
            continue
        item = GoldenItem.model_validate_json(line)
        fixture = _linked_fixture(item)
        if item.answerable and item.review_status == "approved" and fixture in wanted:
            linked[item.id] = fixture
    raw = json.loads((run_dir / "report.json").read_text(encoding="utf-8"))
    results = {entry["item_id"]: ItemResult.model_validate(entry) for entry in raw.get("items", [])}
    missing = sorted(set(linked) - set(results))
    if missing:
        raise ValueError(f"{run_dir}: no result for linked item(s) {', '.join(missing)}")
    by_fixture: dict[str, list[float]] = {}
    for item_id, fixture in sorted(linked.items()):
        result = results[item_id]
        by_fixture.setdefault(fixture, []).append(result.spans_hit_at_5 / result.span_count if result.span_count else 0.0)
    run = RecallRun(
        tier=tier,  # type: ignore[arg-type]
        run_dir=_shown_path(run_dir),
        run_id=str(raw.get("run_id", "")),
        corpus_sha256=raw.get("corpus_sha256"),
        linked_items=len(linked),
    )
    return run, by_fixture


def _shown_path(path: Path) -> str:
    """Repo-relative when the run lives in the repository, so a committed report names no machine path."""
    try:
        return path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _recall(values: dict[str, list[float]] | None, fixtures: Iterable[str]) -> tuple[float, int]:
    if values is None:
        return 0.0, 0
    pooled = [value for fixture in fixtures for value in values.get(fixture, [])]
    return (sum(pooled) / len(pooled) if pooled else 0.0), len(pooled)


def build_parser_eval(
    fixtures_dir: Path,
    routing: RoutingReport,
    cfg: ParseRoutingConfig,
    recall_runs: Mapping[str, Path] | None = None,
) -> tuple[ParserEvalReport, ParserEvalDetails]:
    """The test-set report (micro-averaged over fixtures) and its details: per fixture, per tier coverage, routing misses."""
    scored, excluded = _scored_fixtures(fixtures_dir)
    scored_ids = [row["id"] for row, _expected in scored]
    loaded = {
        tier: load_recall_run(tier, Path(path), scored_ids)
        for tier, path in sorted((recall_runs or {}).items(), key=lambda entry: FORCED_TIERS.index(entry[0]) if entry[0] in FORCED_TIERS else -1)
    }
    recall_values = {tier: values for tier, (_run, values) in loaded.items()}

    def recall_for(tier: str, fixtures: Iterable[str]) -> float:
        return _recall(recall_values.get(_FORCED_TIER[tier]), fixtures)[0]

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
                by_tier={tier: item.metrics(tier, cfg, recall_for(tier, [expected.fixture_id])) for tier, item in counts.items()},
                page_tier_accuracy=page_tier_accuracy([expected], routing)[0],
            )
        )
    summary, combo_details = page_tier_accuracy([expected for _row, expected in scored], routing)
    covered = {tier: item for tier, item in totals.items() if item.fixtures}
    report = ParserEvalReport(
        fixture_id=TEST_SET_ID,
        by_tier={tier: item.metrics(tier, cfg, recall_for(tier, item.fixtures)) for tier, item in covered.items()},
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
    class_of = {row["id"]: row["class"] for row, _expected in scored}
    by_class: list[ClassRecall] = []
    for tier, values in recall_values.items():
        reachable = sorted({fixture for key, item in covered.items() if _FORCED_TIER[key] == tier for fixture in item.fixtures})
        for parse_class in sorted({class_of[fixture] for fixture in reachable}):
            fixtures = [fixture for fixture in reachable if class_of[fixture] == parse_class]
            value, items = _recall(values, fixtures)
            by_class.append(ClassRecall(tier=tier, parse_class=parse_class, fixtures=fixtures, items=items, recall_at_k=value))  # type: ignore[arg-type]
    details = ParserEvalDetails(
        routing_probe_version=routing.probe_version,
        routing_config_version=routing.routing_config_version,
        fixtures=per_fixture,
        tiers=tiers,
        page_tier=combo_details,
        excluded_fixtures=excluded,
        recall_at_k_measured=set(loaded) == set(FORCED_TIERS),
        recall_runs=[run for run, _values in loaded.values()],
        recall_by_class=by_class,
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
    parser.add_argument(
        "--recall-runs",
        nargs="*",
        default=[],
        metavar="TIER=DIR",
        help="forced-tier ingest run outputs (run-smoke --out) for Recall@k per tier: fast=..., structured=..., premium=...",
    )
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
    recall_runs: dict[str, Path] = {}
    for entry in args.recall_runs:
        tier, sep, directory = entry.partition("=")
        if not sep or tier not in FORCED_TIERS or not directory:
            parser.error(f"--recall-runs takes TIER=DIR with TIER one of {', '.join(FORCED_TIERS)}, got {entry}")
        if tier in recall_runs:
            parser.error(f"--recall-runs names {tier} twice")
        recall_runs[tier] = resolve_cli_path(directory)
    try:
        report, details = build_parser_eval(fixtures_dir, routing, cfg, recall_runs=recall_runs)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    _write_atomic(out, _dump(report))
    _write_atomic(details_out, _dump(details))
    below = ", ".join(f"{item.layer_combo}={item.pages_below_expected_tier}" for item in report.page_tier_accuracy)
    print(f"[Parser Eval] {len(details.fixtures)} fixtures, tiers {', '.join(report.by_tier)}; pages below expected tier: {below}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
