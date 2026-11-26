"""Cross-lingual gain of document translation against its cost (XLG-04, D-31).

Arm A runs query translation alone; arm B adds the stored chunk translations (RAG_DOC_TRANSLATION=on and the tenant setting).
One row per query-language and document-language pair of the cross_lingual slice: Recall@10 of both arms, the paired difference
against the noise band, and what arm B added (translation rows, bytes, translation cost in USD, ingestion time). A fixture run
(fixture embedder or fixture translator) is wiring proof only and carries no recommendation.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig, PairedStat
from rag_sidecar.contracts.report import ItemResult

from rag_eval.metrics import CROSS_LINGUAL, language_pair_key
from rag_eval.paired import _stat, item_metrics
from rag_eval.paths import resolve_cli_path

METRIC = "recall_at_10"
NO_MEASURABLE_GAIN = "no measurable gain"
WIRING_PROOF_LABEL = (
    "wiring proof: fixture embedder and fixture translator; the numbers prove the comparison runs, not that translation helps"
)
FIXTURE_TRANSLATOR = "fixture-translator"
FIXTURE_EMBEDDER_PREFIX = "fixture"
EXIT_OK = 0
EXIT_INVALID = 2

Verdict = Literal["gain", "loss", "no measurable gain", "no data"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DirectionCost(_Model):
    """What translating chunks of one language into another added (arm B only)."""

    rows: int = Field(default=0, ge=0)
    bytes: int = Field(default=0, ge=0)
    usd: float = Field(default=0.0, ge=0)
    ingestion_seconds: float = Field(default=0.0, ge=0)


class TranslationCost(_Model):
    """Keyed by "<document language>-><query language>", the direction a chunk is translated."""

    by_direction: dict[str, DirectionCost] = Field(default_factory=dict)
    translator: str | None = None


class TranslationPairRow(_Model):
    pair: str
    query_language: str
    document_language: str
    n: int = Field(ge=0)
    recall_a: float | None
    recall_b: float | None
    paired: PairedStat
    band: float
    verdict: Verdict
    added_rows: int = Field(ge=0)
    added_bytes: int = Field(ge=0)
    translation_usd: float = Field(ge=0)
    added_ingestion_seconds: float = Field(ge=0)


class TranslationComparison(_Model):
    schema_version: Literal[1] = 1
    metric: Literal["recall_at_10"] = METRIC
    wiring_proof: bool
    label: str | None
    pairs: list[TranslationPairRow]
    total_added_rows: int = Field(ge=0)
    total_added_bytes: int = Field(ge=0)
    total_translation_usd: float = Field(ge=0)
    total_added_ingestion_seconds: float = Field(ge=0)
    recommendation: str | None
    notes: list[str] = Field(default_factory=list)


def _pairs(items: list[ItemResult]) -> dict[str, list[ItemResult]]:
    members: dict[str, list[ItemResult]] = {}
    for item in items:
        if item.category != CROSS_LINGUAL or item.evidence_language is None or not item.answerable:
            continue
        members.setdefault(language_pair_key(item.language, item.evidence_language), []).append(item)
    return members


def _mean(values: list[float]) -> float | None:
    return round(math.fsum(values) / len(values), 6) if values else None


def _verdict(stat: PairedStat, band: float) -> Verdict:
    if stat.n == 0 or stat.mean_d is None:
        return "no data"
    if stat.mean_d > band and stat.ci_low is not None and stat.ci_low > 0:
        return "gain"
    if stat.mean_d < -band and stat.ci_high is not None and stat.ci_high < 0:
        return "loss"
    return NO_MEASURABLE_GAIN


def _recommendation(rows: list[TranslationPairRow]) -> str:
    gains = [row.pair for row in rows if row.verdict == "gain"]
    if not gains:
        return (
            "Leave document translation off: no language pair gains beyond the noise band. Turn it on for a tenant only when "
            "its pairs gain beyond the noise band."
        )
    return (
        "Turn document translation on for a tenant only for the pairs whose gain is beyond the noise band: "
        + ", ".join(gains)
        + ". Weigh the added rows, bytes, cost and ingestion time shown next to each pair."
    )


def build_translation_comparison(
    arm_a: list[ItemResult],
    arm_b: list[ItemResult],
    cost: TranslationCost,
    noise: NoiseConfig,
    *,
    wiring_proof: bool,
) -> TranslationComparison:
    band = noise.floor
    by_id_b = {item.item_id: item for item in arm_b}
    pairs_a = _pairs(arm_a)
    pairs_b = _pairs(arm_b)
    rows: list[TranslationPairRow] = []
    for pair in sorted(set(pairs_a) | set(pairs_b)):
        members_a = pairs_a.get(pair, [])
        recall_a = [value for item in members_a if (value := item_metrics(item)[METRIC]) is not None]
        recall_b = [value for item in pairs_b.get(pair, []) if (value := item_metrics(item)[METRIC]) is not None]
        differences: list[float] = []
        for item in members_a:
            other = by_id_b.get(item.item_id)
            if other is None:
                continue
            observed = item_metrics(other)[METRIC]
            reference = item_metrics(item)[METRIC]
            if observed is None or reference is None:
                continue
            differences.append(observed - reference)
        stat = _stat(differences)
        if stat.mean_d is not None:
            stat = stat.model_copy(update={"mean_d": round(stat.mean_d, 6)})
        query_language, document_language = pair.split("->", 1)
        spent = cost.by_direction.get(f"{document_language}->{query_language}", DirectionCost())
        rows.append(
            TranslationPairRow(
                pair=pair,
                query_language=query_language,
                document_language=document_language,
                n=len(differences),
                recall_a=_mean(recall_a),
                recall_b=_mean(recall_b),
                paired=stat,
                band=band,
                verdict=_verdict(stat, band),
                added_rows=spent.rows,
                added_bytes=spent.bytes,
                translation_usd=spent.usd,
                added_ingestion_seconds=spent.ingestion_seconds,
            )
        )
    totals = list(cost.by_direction.values())
    notes = [f"Paired difference is arm B minus arm A on {METRIC}; the noise band is the noise floor ({band})."]
    return TranslationComparison(
        wiring_proof=wiring_proof,
        label=WIRING_PROOF_LABEL if wiring_proof else None,
        pairs=rows,
        total_added_rows=sum(entry.rows for entry in totals),
        total_added_bytes=sum(entry.bytes for entry in totals),
        total_translation_usd=round(math.fsum(entry.usd for entry in totals), 4),
        total_added_ingestion_seconds=round(math.fsum(entry.ingestion_seconds for entry in totals), 3),
        recommendation=None if wiring_proof else _recommendation(rows),
        notes=notes,
    )


def _fmt(value: float | None, digits: int = 4) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def render_markdown(report: TranslationComparison) -> str:
    lines = ["# Document translation: cross-lingual gain against cost", ""]
    if report.label:
        lines += [f"> {report.label}", ""]
    lines += [
        f"Metric: {report.metric} on the cross_lingual slice. Arm A: query translation alone. Arm B: plus document translations.",
        "",
        "| Pair | n | Recall A | Recall B | Paired diff | 95% CI | Band | Verdict | Added rows | Added bytes | Cost USD | Added ingest s |",
        "| --- | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: |",
    ]
    for row in report.pairs:
        interval = f"[{_fmt(row.paired.ci_low)}, {_fmt(row.paired.ci_high)}]"
        lines.append(
            f"| {row.pair} | {row.n} | {_fmt(row.recall_a)} | {_fmt(row.recall_b)} | {_fmt(row.paired.mean_d)} | {interval} | "
            f"{_fmt(row.band, 2)} | {row.verdict} | {row.added_rows} | {row.added_bytes} | {row.translation_usd:.4f} | "
            f"{row.added_ingestion_seconds:.2f} |"
        )
    lines += [
        "",
        f"Totals for arm B: {report.total_added_rows} rows, {report.total_added_bytes} bytes, "
        f"{report.total_translation_usd:.4f} USD, {report.total_added_ingestion_seconds:.2f} s of ingestion.",
    ]
    if report.recommendation:
        lines += ["", "## Recommendation", "", report.recommendation]
    for note in report.notes:
        lines += ["", note]
    return "\n".join(lines) + "\n"


def _load_items(path: Path) -> tuple[list[ItemResult], str | None]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("items"), list):
        raise ValueError(f"{path}: not an eval report (no items)")
    embedder = raw.get("embedder_id")
    return [ItemResult.model_validate(item) for item in raw["items"]], embedder if isinstance(embedder, str) else None


def _is_fixture(embedders: list[str | None], translator: str | None) -> bool:
    return translator == FIXTURE_TRANSLATOR or any(
        embedder is not None and embedder.startswith(FIXTURE_EMBEDDER_PREFIX) for embedder in embedders
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.translation_compare", description=__doc__)
    parser.add_argument("--arm-a", required=True, help="report.json of the query-translation-only run")
    parser.add_argument("--arm-b", required=True, help="report.json of the run with document translations")
    parser.add_argument("--cost", required=True, help="JSON with by_direction rows, bytes, usd and ingestion_seconds")
    parser.add_argument("--noise", required=True, help="eval/config/noise.json")
    parser.add_argument("--out", required=True, help="directory for translation-compare.json and .md")
    args = parser.parse_args(argv)
    try:
        items_a, embedder_a = _load_items(resolve_cli_path(args.arm_a))
        items_b, embedder_b = _load_items(resolve_cli_path(args.arm_b))
        cost = TranslationCost.model_validate_json(resolve_cli_path(args.cost).read_text(encoding="utf-8"))
        noise = NoiseConfig.model_validate_json(resolve_cli_path(args.noise).read_text(encoding="utf-8"))
    except (OSError, ValueError, ValidationError) as error:
        print(f"[Translation Compare] invalid input: {error}", file=sys.stderr)
        return EXIT_INVALID
    report = build_translation_comparison(
        items_a, items_b, cost, noise, wiring_proof=_is_fixture([embedder_a, embedder_b], cost.translator)
    )
    out = resolve_cli_path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "translation-compare.json").write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    (out / "translation-compare.md").write_text(render_markdown(report), encoding="utf-8")
    print(f"[Translation Compare] {len(report.pairs)} pair(s) written to {out}")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
