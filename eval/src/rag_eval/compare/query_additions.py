"""Phase 6.2 decision record: per-switch eligibility from the fixture arms and the D-31 checklist (D-10, D-31).

Each arm directory holds report.json, gate.json and traces.jsonl. The tool reduces every arm to a summary (slice values
computed from the report's gated items, trace latencies and counts), decides each switch against the arm before it with
the noise band of eval/config/noise.json, and writes a comparison report plus eval/decisions/06.2-query-additions.json.
Eligibility never reads a favourable split: speculative retrieval is judged on the all-turns pre-retrieval p95 (D-37,
P-09) and every slice is compared, so a regression cannot hide in an average (T-06.2-83). Counts, ids, codes and timings
only; no query or document text reaches the report.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.latency import StageLatency
from rag_sidecar.contracts.query_additions import (
    D31CheckEntry,
    QueryAdditionsDecisionRecord,
    SpeculativeTrace,
    SwitchDecision,
)
from rag_sidecar.contracts.report import EvalReport, ItemResult

from rag_eval.metrics import report_gate_items
from rag_eval.paired import _slice_members, item_metrics
from rag_eval.paths import repo_relative, resolve_cli_path
from rag_eval.report import QUERY_PARALLEL_STAGES, nearest_rank, query_stage_latency
from rag_eval.traces import load_traces

__all__ = ["EXIT_STALE", "SWITCH_NAMES", "RagTrace", "SpeculativeTrace", "main", "pre_retrieval_ms"]

EXIT_OK = 0
EXIT_STALE = 1
EXIT_INVALID = 2

DEFAULT_OUT = "eval/reports/q62-additions-fixture"
DEFAULT_DECISION = "eval/decisions/06.2-query-additions.json"
DEFAULT_NOISE = "eval/config/noise.json"
DEFAULT_BUDGETS = "eval/config/latency-budgets.json"
DEFAULT_CASES = "eval/fixtures/lang-detect/cases.jsonl"
ARM_PREFIX = "q62-"
WHATSAPP_FILE = "whatsapp-report.json"
DEFAULTS_ARM = re.compile(r"(^|-)defaults(-ingest)?$")
DIGITS = 6

VOICE_TRANSLATE = "RAG_QUERY_VOICE_TRANSFORMS:translate"
SUBQ_TARGETS = ("category:scoped_compound", "category:version_compare")
REQUIRED_TARGET = "category:scoped_compound"
SUBQ_FAMILIES = (
    ("all_evidence_recall_at_5", "all_evidence_recall_at_10"),
    ("subq_coverage_at_5", "subq_coverage_at_10"),
)
RETRIEVAL_METRICS = ("recall_at_5", "recall_at_10", "mrr")
REFUSAL_METRICS = ("correct_refusal_rate", "false_refusal_rate")
CROSS_LINGUAL_SLICE = "category:cross_lingual"
PAIR_PREFIX = "pair:"
GENERATION_STAGE = "generation"
SCOPE_GATE_STAGE = "scope_gate"
OUT_OF_SCOPE = "out_of_scope"
# D-37: request start to the end of fuse; the parallel transform group counts with its slowest member.
PRE_RETRIEVAL_SEQUENTIAL = (
    "access_scope",
    "query_gate",
    "condense",
    "terminology",
    "semantic_cache",
    "embed",
    "scope_gate",
    "search",
    "fuse",
)
FUSE_STAGE = "fuse"
CONFIDENT_SOURCES = frozenset({"detector", "single_language"})
VOICE_PROFILE = "voice"
CHAT_PROFILE = "chat"
FALLBACK_VOICE_QUERY_P95 = 300.0
FALLBACK_SCOPE_GATE_P95 = 5.0

# D-31 letters that rest on named test files (the vitest JSON reporter output given with --tests).
LETTER_TESTS: dict[str, tuple[str, ...]] = {
    "c": (
        "tests/rag/query/glossary-translate.test.ts",
        "tests/rag/query/glossary-rewrite.test.ts",
        "tests/rag/ingest-translate-glossary.test.ts",
    ),
    "d": ("tests/rag/lang/detect-cases.test.ts", "tests/rag/lang/resolve-query-language.test.ts"),
    "f": ("tests/rag/query/speculative.test.ts", "tests/rag/model-router.test.ts"),
    "g": ("tests/rag/query/history-fallback.test.ts", "tests/whatsapp/history.test.ts"),
    "h": ("tests/rag/scope/stage.test.ts",),
}

Rule = Literal["subq", "glossary", "speculative", "routing", "scope_gate", "voice_translate"]
SWITCHES: tuple[tuple[str, str, str, Rule], ...] = (
    ("RAG_QUERY_DECOMPOSE", "decompose", "single-pass", "subq"),
    ("RAG_QUERY_DECOMPOSE_COMPLETENESS", "completeness", "decompose", "subq"),
    ("RAG_QUERY_SUBQ_FILTERS", "subq-filters", "completeness", "subq"),
    ("RAG_TRANSLATION_GLOSSARY", "glossary", "single-pass", "glossary"),
    ("RAG_SPECULATIVE_RETRIEVAL", "speculative", "single-pass", "speculative"),
    ("RAG_MODEL_ROUTING", "routing", "single-pass", "routing"),
    ("RAG_SCOPE_GATE", "scope-gate", "single-pass", "scope_gate"),
    (VOICE_TRANSLATE, "voice-translate", "voice-no-translate", "voice_translate"),
)
SWITCH_NAMES: tuple[str, ...] = tuple(name for name, *_ in SWITCHES)
KNOWN_ARMS = frozenset(arm for _, arm, reference, _ in SWITCHES for arm in (arm, reference))


class QueryAdditionsError(RuntimeError):
    pass


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class InputFile(_Model):
    kind: Literal["arm", "whatsapp", "tests", "noise", "budgets", "cases"]
    name: str
    path: str
    sha256: str


class PreRetrieval(_Model):
    all_turns: StageLatency | None
    new_variant: StageLatency | None
    no_new_variant: StageLatency | None


class ArmLatency(_Model):
    pre_retrieval: PreRetrieval
    query_stage: StageLatency | None
    generation: StageLatency | None
    scope_gate: StageLatency | None


class LanguageSourceSlice(_Model):
    items: int = Field(ge=0)
    recall_at_5: float | None
    false_refusal_rate: float | None


class ArmSummary(_Model):
    name: str
    path: str
    tier: str
    embedder_id: str | None
    gate_passed: bool | None
    paired_all_zero: bool | None
    traces: int = Field(ge=0)
    speculative_traced: int = Field(ge=0)
    model_route_traced: int = Field(ge=0)
    unanswerable_out_of_scope_refused: int = Field(ge=0)
    slices: dict[str, dict[str, float | None]]
    latency: ArmLatency
    language_source_slices: dict[str, LanguageSourceSlice] = Field(default_factory=dict)


class WhatsAppSummary(_Model):
    path: str
    passed: bool
    totals: dict[str, int]


class TestFileResult(_Model):
    status: Literal["passed", "failed", "missing"]


class PairRow(_Model):
    reference: dict[str, float | None]
    candidate: dict[str, float | None]


class SwitchReport(_Model):
    name: str
    arm: str
    reference_arm: str
    eligible: bool
    improved_slices: list[str]
    regressions: list[str]
    notes: str


class QueryAdditionsReport(_Model):
    schema_version: Literal[1] = 1
    source: Literal["fixture", "live"]
    noise_floor: float
    noise_k: float
    budgets: dict[str, float]
    inputs: list[InputFile]
    ignored_runs: list[str]
    arms: dict[str, ArmSummary]
    whatsapp: WhatsAppSummary | None
    tests: dict[str, TestFileResult]
    switches: list[SwitchReport]
    d31_checklist: list[D31CheckEntry]
    voice_pairs: dict[str, PairRow]
    notes: list[str]


NOTES = [
    "Noise band per slice and metric: max(k * spread, floor) with a single-run reference arm, so the band is the floor.",
    "Improvement: a slice metric strictly better than the reference arm; regression: worse beyond the band.",
    (
        "Pre-retrieval time (D-37): request start to the end of fuse, the parallel transform group counted by its "
        "slowest member, minus the traced speculative overlap; eligibility uses the all-turns p95, the new-variant "
        "split is report-only."
    ),
    (
        "language_source:<source> slices (P-21) list items whose language the LANG-08 chain resolved past the "
        "confident detector; report-only."
    ),
    "Fixture numbers prove the wiring and the rules; the live comparison is an operator run.",
]


# ---------- helpers


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, DIGITS)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _stable_json(payload: object) -> str:
    return json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _resolve(raw: str | Path) -> Path:
    path = Path(raw)
    if path.is_absolute():
        return path
    local = Path.cwd() / path
    return local if local.exists() else resolve_cli_path(path)


def _stat(values: list[float]) -> StageLatency | None:
    if not values:
        return None
    return StageLatency(p50_ms=_round(nearest_rank(values, 0.5)) or 0.0, p95_ms=_round(nearest_rank(values, 0.95)) or 0.0, n=len(values))


def _fmt(value: float | None) -> str:
    return "n/a" if value is None else f"{value:g}"


def _latency_value(trace: RagTrace, stage: str) -> float | None:
    value = trace.stage_latency_ms.get(stage)
    if value is None or not math.isfinite(value) or value < 0:
        return None
    return value


def pre_retrieval_ms(trace: RagTrace) -> float | None:
    """D-37: request start to the end of fuse; None when the turn never reached fuse (a cache hit or a refusal)."""
    if _latency_value(trace, FUSE_STAGE) is None:
        return None
    sequential = [v for stage in PRE_RETRIEVAL_SEQUENTIAL if (v := _latency_value(trace, stage)) is not None]
    parallel = [v for stage in QUERY_PARALLEL_STAGES if (v := _latency_value(trace, stage)) is not None]
    total = math.fsum(sequential) + (max(parallel) if parallel else 0.0)
    overlap = trace.speculative.overlap_ms if trace.speculative is not None else 0.0
    return max(0.0, total - overlap)


def _new_variant(trace: RagTrace) -> bool:
    plan = trace.query_plan
    return plan is not None and any(variant.kind != "original" for variant in plan.variants)


# ---------- arm summaries


def slice_values(items: list[ItemResult], metrics: Iterable[str]) -> dict[str, dict[str, float | None]]:
    """Per slice, the mean item value of each metric; sub-question coverage is pooled over sub-questions (D-10)."""
    wanted = tuple(metrics)
    out: dict[str, dict[str, float | None]] = {}
    for slice_name, members in sorted(_slice_members(items).items()):
        values: dict[str, float | None] = {}
        for metric in wanted:
            if metric.startswith("subq_coverage_at_"):
                k = metric.rsplit("_", 1)[1]
                scored = [item for item in members if item.subq_total]
                total = sum(item.subq_total or 0 for item in scored)
                hits = sum(getattr(item, f"subq_hit_at_{k}") or 0 for item in scored)
                values[metric] = _round(hits / total) if total else None
                continue
            present = [v for item in members if (v := item_metrics(item).get(metric)) is not None]
            values[metric] = _round(math.fsum(present) / len(present)) if present else None
        out[slice_name] = values
    return out


def _gate_flags(path: Path) -> tuple[bool | None, bool | None]:
    if not path.is_file():
        return None, None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise QueryAdditionsError(f"{path}: gate.json is not an object")
    paired = payload.get("paired")
    all_zero = paired.get("all_zero") if isinstance(paired, dict) else None
    return bool(payload.get("passed")), (bool(all_zero) if all_zero is not None else None)


def _language_sources(items: list[ItemResult], traces: list[RagTrace]) -> dict[str, LanguageSourceSlice]:
    by_id = {item.item_id: item for item in items}
    groups: dict[str, list[ItemResult]] = {}
    for trace in traces:
        plan = trace.query_plan
        detection = plan.language_detection if plan is not None else None
        if detection is None or detection.source in CONFIDENT_SOURCES or trace.item_id not in by_id:
            continue
        groups.setdefault(f"language_source:{detection.source}", []).append(by_id[trace.item_id])
    out: dict[str, LanguageSourceSlice] = {}
    for name, members in sorted(groups.items()):
        values = slice_values(members, ("recall_at_5", "false_refusal_rate"))["overall"]
        out[name] = LanguageSourceSlice(items=len(members), recall_at_5=values["recall_at_5"], false_refusal_rate=values["false_refusal_rate"])
    return out


def summarize_arm(name: str, directory: Path, noise: NoiseConfig) -> ArmSummary:
    try:
        report = EvalReport.model_validate_json((directory / "report.json").read_text(encoding="utf-8"))
        traces = load_traces(directory / "traces.jsonl") if (directory / "traces.jsonl").is_file() else []
        gate_passed, all_zero = _gate_flags(directory / "gate.json")
    except (OSError, ValidationError, ValueError) as exc:
        raise QueryAdditionsError(f"{directory}: {exc}") from exc
    items = report_gate_items(report.items, report.golden_filter.gate_split, report.gate_population)
    by_id = {item.item_id: item for item in report.items}
    pre_all: list[float] = []
    pre_new: list[float] = []
    pre_old: list[float] = []
    for trace in traces:
        value = pre_retrieval_ms(trace)
        if value is None:
            continue
        pre_all.append(value)
        (pre_new if _new_variant(trace) else pre_old).append(value)
    refused_out_of_scope = sum(
        1
        for trace in traces
        if trace.scope_gate is not None
        and trace.scope_gate.label == OUT_OF_SCOPE
        and (item := by_id.get(trace.item_id or "")) is not None
        and not item.answerable
        and item.refused
    )
    return ArmSummary(
        name=name,
        path=repo_relative(directory),
        tier=report.tier,
        embedder_id=report.embedder_id,
        gate_passed=gate_passed,
        paired_all_zero=all_zero,
        traces=len(traces),
        speculative_traced=sum(1 for trace in traces if trace.speculative is not None),
        model_route_traced=sum(1 for trace in traces if trace.model_route is not None),
        unanswerable_out_of_scope_refused=refused_out_of_scope,
        slices=slice_values(items, noise.metrics),
        latency=ArmLatency(
            pre_retrieval=PreRetrieval(all_turns=_stat(pre_all), new_variant=_stat(pre_new), no_new_variant=_stat(pre_old)),
            query_stage=_stat([v for trace in traces if (v := query_stage_latency(trace)) is not None]),
            generation=_stat([v for trace in traces if (v := _latency_value(trace, GENERATION_STAGE)) is not None]),
            scope_gate=_stat([trace.scope_gate.latency_ms for trace in traces if trace.scope_gate is not None]),
        ),
        language_source_slices=_language_sources(items, traces),
    )


def _whatsapp(path: Path) -> WhatsAppSummary:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise QueryAdditionsError(f"{path}: {exc}") from exc
    totals = payload.get("totals") if isinstance(payload, dict) else None
    return WhatsAppSummary(
        path=repo_relative(path),
        passed=bool(payload.get("passed")) if isinstance(payload, dict) else False,
        totals={key: int(value) for key, value in (totals or {}).items() if isinstance(value, int | float)},
    )


def _test_results(paths: list[Path]) -> dict[str, TestFileResult]:
    statuses: dict[str, str] = {}
    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise QueryAdditionsError(f"{path}: {exc}") from exc
        for result in payload.get("testResults", []) if isinstance(payload, dict) else []:
            name = str(result.get("name", "")).replace("\\", "/")
            for required in {test for tests in LETTER_TESTS.values() for test in tests}:
                if name.endswith("/" + required) or name == required:
                    failed = result.get("status") != "passed" or statuses.get(required) == "failed"
                    statuses[required] = "failed" if failed else "passed"
    required = sorted({test for tests in LETTER_TESTS.values() for test in tests})
    return {name: TestFileResult(status=statuses.get(name, "missing")) for name in required}  # type: ignore[arg-type]


# ---------- decisions


def _band(noise: NoiseConfig) -> float:
    return max(noise.k * 0.0, noise.floor)


def _deltas(candidate: ArmSummary, reference: ArmSummary, noise: NoiseConfig) -> list[tuple[str, str, float]]:
    out = []
    for slice_name in sorted(set(candidate.slices) & set(reference.slices)):
        for metric in noise.metrics:
            cand = candidate.slices[slice_name].get(metric)
            ref = reference.slices[slice_name].get(metric)
            if cand is None or ref is None:
                continue
            out.append((slice_name, metric, round(cand - ref, DIGITS)))
    return out


def _better(metric: str, delta: float, noise: NoiseConfig) -> bool:
    return delta > 0 if noise.metrics.get(metric, "higher") == "higher" else delta < 0


def regressions(candidate: ArmSummary, reference: ArmSummary, noise: NoiseConfig, metrics: Iterable[str] | None = None) -> list[str]:
    allowed = set(metrics) if metrics is not None else None
    band = _band(noise)
    out = []
    for slice_name, metric, delta in _deltas(candidate, reference, noise):
        if allowed is not None and metric not in allowed:
            continue
        worse = -delta if noise.metrics.get(metric, "higher") == "higher" else delta
        if worse > band:
            out.append(f"{slice_name}:{metric}")
    return out


def _improved(candidate: ArmSummary, reference: ArmSummary, slice_name: str, metrics: Iterable[str], noise: NoiseConfig) -> bool:
    """At least one of the metrics is better and none is worse, on a slice both arms measure."""
    seen = False
    better = False
    for metric in metrics:
        cand = candidate.slices.get(slice_name, {}).get(metric)
        ref = reference.slices.get(slice_name, {}).get(metric)
        if cand is None or ref is None:
            continue
        seen = True
        delta = round(cand - ref, DIGITS)
        if delta == 0:
            continue
        if not _better(metric, delta, noise):
            return False
        better = True
    return seen and better


def _subq_rule(candidate: ArmSummary, reference: ArmSummary, noise: NoiseConfig) -> tuple[bool, list[str], list[str], str]:
    present = [
        target
        for target in SUBQ_TARGETS
        if any(candidate.slices.get(target, {}).get(m) is not None and reference.slices.get(target, {}).get(m) is not None for family in SUBQ_FAMILIES for m in family)
    ]
    improved = [target for target in present if all(_improved(candidate, reference, target, family, noise) for family in SUBQ_FAMILIES)]
    drops = regressions(candidate, reference, noise)
    notes = [f"targets measured: {', '.join(present) or 'none'}"]
    if REQUIRED_TARGET not in present:
        notes.append(f"{REQUIRED_TARGET} not measured in both arms")
    eligible = REQUIRED_TARGET in present and set(improved) == set(present) and not drops
    return eligible, improved, drops, "; ".join(notes)


def _changed_slices(candidate: ArmSummary, reference: ArmSummary, noise: NoiseConfig) -> list[str]:
    return sorted({slice_name for slice_name, metric, delta in _deltas(candidate, reference, noise) if delta != 0 and _better(metric, delta, noise)})


def _tests_passed(tests: dict[str, TestFileResult], letter: str) -> tuple[bool, str]:
    files = LETTER_TESTS[letter]
    bad = [f"{name} {tests[name].status}" for name in files if tests.get(name, TestFileResult(status="missing")).status != "passed"]
    if bad:
        return False, "tests not passed: " + ", ".join(bad)
    return True, "tests passed: " + ", ".join(files)


def _p95(stat: StageLatency | None) -> float | None:
    return None if stat is None else stat.p95_ms


def _decide_switch(
    rule: Rule,
    candidate: ArmSummary,
    reference: ArmSummary,
    noise: NoiseConfig,
    budgets: Mapping[str, float],
    tests: dict[str, TestFileResult],
    off_equal: tuple[bool, str],
) -> tuple[bool, list[str], list[str], str]:
    band = _band(noise)
    if rule == "subq":
        return _subq_rule(candidate, reference, noise)
    if rule == "glossary":
        drops = regressions(candidate, reference, noise)
        passed, evidence = _tests_passed(tests, "c")
        return passed and not drops, _changed_slices(candidate, reference, noise), drops, evidence
    if rule == "speculative":
        drops = regressions(candidate, reference, noise)
        cand = _p95(candidate.latency.pre_retrieval.all_turns)
        ref = _p95(reference.latency.pre_retrieval.all_turns)
        lower = cand is not None and ref is not None and cand < ref
        note = f"all-turns pre-retrieval p95 {_fmt(cand)} ms vs {_fmt(ref)} ms"
        return lower and not drops, _changed_slices(candidate, reference, noise), drops, note
    if rule == "routing":
        refusal_moves = [
            f"{slice_name}:{metric}"
            for slice_name, metric, delta in _deltas(candidate, reference, noise)
            if metric in REFUSAL_METRICS and (slice_name == "overall" or slice_name.startswith(("language:", "category:"))) and abs(delta) > band
        ]
        drops = sorted(set(regressions(candidate, reference, noise)) | set(refusal_moves))
        cand = _p95(candidate.latency.generation)
        ref = _p95(reference.latency.generation)
        lower = cand is not None and ref is not None and cand < ref
        note = f"generation p95 {_fmt(cand)} ms vs {_fmt(ref)} ms against the fixed quality model; answer correctness is a live judge run"
        return lower and not drops, _changed_slices(candidate, reference, noise), drops, note
    if rule == "scope_gate":
        cand = candidate.slices.get("overall", {}).get("correct_refusal_rate")
        ref = reference.slices.get("overall", {}).get("correct_refusal_rate")
        up = cand is not None and ref is not None and round(cand - ref, DIGITS) > 0
        drops = regressions(candidate, reference, noise, ("false_refusal_rate",))
        improved = ["overall"] if up else []
        note = f"correct refusals {_fmt(cand)} vs {_fmt(ref)}; off equal to baseline: {off_equal[1]}"
        return up and not drops and off_equal[0], improved, drops, note
    # voice_translate (D-16)
    retrieval_noise = noise.model_copy(update={"metrics": {m: noise.metrics.get(m, "higher") for m in RETRIEVAL_METRICS}})
    xl = _improved(candidate, reference, CROSS_LINGUAL_SLICE, RETRIEVAL_METRICS, retrieval_noise)
    pairs = sorted(s for s in candidate.slices if s.startswith(PAIR_PREFIX) and _improved(candidate, reference, s, RETRIEVAL_METRICS, retrieval_noise))
    drops = regressions(candidate, reference, noise)
    p95 = _p95(candidate.latency.query_stage)
    budget = budgets["voice_query_p95_ms"]
    within = p95 is not None and p95 <= budget
    improved = ([CROSS_LINGUAL_SLICE] if xl else []) + pairs
    note = f"query-stage voice p95 {_fmt(p95)} ms (budget {budget:g} ms)"
    return xl and within and not drops, improved, drops, note


def _defaults_check(arms: Mapping[str, ArmSummary]) -> tuple[bool, str]:
    defaults = [arm for name, arm in sorted(arms.items()) if DEFAULTS_ARM.search(name)]
    if not defaults:
        return False, "no defaults run (q62-*defaults) supplied"
    parts = [f"{arm.name}: gate passed={arm.gate_passed}, paired all_zero={arm.paired_all_zero}" for arm in defaults]
    ok = all(arm.gate_passed is True and arm.paired_all_zero is True for arm in defaults)
    return ok, "; ".join(parts)


def decide(
    arms: Mapping[str, ArmSummary],
    whatsapp: WhatsAppSummary | None,
    tests: dict[str, TestFileResult],
    noise: NoiseConfig,
    budgets: Mapping[str, float],
    cases: tuple[int, str] | None,
) -> tuple[list[SwitchReport], list[D31CheckEntry]]:
    off_equal = _defaults_check(arms)
    switches: list[SwitchReport] = []
    for name, arm, reference_arm, rule in SWITCHES:
        candidate, reference = arms.get(arm), arms.get(reference_arm)
        if candidate is None or reference is None:
            missing = [f"{ARM_PREFIX}{a}" for a, s in ((arm, candidate), (reference_arm, reference)) if s is None]
            switches.append(SwitchReport(name=name, arm=arm, reference_arm=reference_arm, eligible=False, improved_slices=[], regressions=[], notes=f"arm {', '.join(missing)} missing ({arm} vs {reference_arm})"))
            continue
        eligible, improved, drops, notes = _decide_switch(rule, candidate, reference, noise, budgets, tests, off_equal)
        switches.append(SwitchReport(name=name, arm=arm, reference_arm=reference_arm, eligible=eligible, improved_slices=improved, regressions=drops, notes=notes[:2000]))
    by_name = {switch.name: switch for switch in switches}
    checks: list[D31CheckEntry] = []

    def add(letter: str, passed: bool, evidence: str) -> None:
        checks.append(D31CheckEntry(letter=letter, passed=passed, evidence=evidence[:2000]))  # type: ignore[arg-type]

    add("a", off_equal[0], off_equal[1])
    single, completeness = arms.get("single-pass"), arms.get("completeness")
    if single is None or completeness is None:
        add("b", False, "single-pass or completeness arm missing")
    else:
        ok, improved, drops, note = _subq_rule(completeness, single, noise)
        add("b", ok, f"completeness vs single-pass: improved {improved or 'none'}, regressions {drops or 'none'}; {note}")
    glossary = by_name["RAG_TRANSLATION_GLOSSARY"]
    tests_c = _tests_passed(tests, "c")
    add("c", glossary.eligible and tests_c[0], f"glossary entry eligible={glossary.eligible}; {tests_c[1]}")
    tests_d = _tests_passed(tests, "d")
    case_note = f"{cases[0]} detection cases (sha256 {cases[1][:12]})" if cases else "detection case file missing"
    add("d", tests_d[0] and cases is not None, f"{case_note}; {tests_d[1]}")
    voice_on, voice_off = arms.get("voice-translate"), arms.get("voice-no-translate")
    if voice_on is None or voice_off is None:
        add("e", False, "voice arms missing")
    else:
        pairs = sorted(s for s in voice_on.slices if s.startswith(PAIR_PREFIX))
        gated = voice_on.gate_passed is True and voice_off.gate_passed is True
        add("e", bool(pairs) and gated, f"pairs {', '.join(pairs) or 'none'}; voice gates passed={gated}; {by_name[VOICE_TRANSLATE].notes}")
    speculative, routing = arms.get("speculative"), arms.get("routing")
    tests_f = _tests_passed(tests, "f")
    traced = speculative is not None and speculative.speculative_traced > 0 and routing is not None and routing.model_route_traced > 0
    add(
        "f",
        traced and tests_f[0],
        f"speculative traced on {speculative.speculative_traced if speculative else 0} turns, model_route on "
        f"{routing.model_route_traced if routing else 0}; eligibility recorded; {tests_f[1]}",
    )
    tests_g = _tests_passed(tests, "g")
    whatsapp_ok = whatsapp is not None and whatsapp.passed
    add("g", whatsapp_ok and tests_g[0], f"WhatsApp report passed={whatsapp.passed if whatsapp else 'missing'}; {tests_g[1]}")
    scope = arms.get("scope-gate")
    tests_h = _tests_passed(tests, "h")
    if scope is None:
        add("h", False, "scope-gate arm missing")
    else:
        p95 = _p95(scope.latency.scope_gate)
        budget = budgets["scope_gate_p95_ms"]
        entry = by_name["RAG_SCOPE_GATE"]
        ok = scope.unanswerable_out_of_scope_refused > 0 and p95 is not None and p95 <= budget and not entry.regressions and off_equal[0] and tests_h[0]
        add(
            "h",
            ok,
            f"{scope.unanswerable_out_of_scope_refused} unanswerable items refused out_of_scope; scope gate p95 {_fmt(p95)} ms "
            f"(budget {budget:g} ms); false-refusal regressions {entry.regressions or 'none'}; off equal {off_equal[0]}; {tests_h[1]}",
        )
    add("i", True, f"written by rag_eval.compare query-additions from {len(arms)} arm runs")
    return switches, checks


# ---------- build, write, check


def _budgets(path: Path) -> dict[str, float]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    profiles = payload.get("profiles", {})

    def group(profile: str, name: str, fallback: float) -> float:
        value = profiles.get(profile, {}).get("groups", {}).get(name, {}).get("p95_ms")
        return float(value) if isinstance(value, int | float) else fallback

    return {
        "voice_query_p95_ms": group(VOICE_PROFILE, "query", FALLBACK_VOICE_QUERY_P95),
        "scope_gate_p95_ms": group(CHAT_PROFILE, "scope_gate", FALLBACK_SCOPE_GATE_P95),
    }


def _cases(path: Path) -> tuple[int, str] | None:
    if not path.is_file():
        return None
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return len(lines), _sha256(path)


def build_report(
    runs: list[Path],
    tests: list[Path],
    noise_path: Path,
    budgets_path: Path,
    cases_path: Path,
    whatsapp_path: Path | None,
    source: Literal["fixture", "live"] | None,
) -> QueryAdditionsReport:
    try:
        noise = NoiseConfig.model_validate_json(noise_path.read_text(encoding="utf-8"))
        budgets = _budgets(budgets_path)
    except (OSError, ValidationError, ValueError) as exc:
        raise QueryAdditionsError(f"config: {exc}") from exc
    inputs: list[InputFile] = [
        InputFile(kind="noise", name="noise", path=repo_relative(noise_path), sha256=_sha256(noise_path)),
        InputFile(kind="budgets", name="latency-budgets", path=repo_relative(budgets_path), sha256=_sha256(budgets_path)),
    ]
    arms: dict[str, ArmSummary] = {}
    ignored: list[str] = []
    for directory in sorted(runs, key=lambda p: p.name):
        if (directory / WHATSAPP_FILE).is_file() and not (directory / "report.json").is_file():
            whatsapp_path = whatsapp_path or directory / WHATSAPP_FILE
            continue
        name = directory.name.removeprefix(ARM_PREFIX)
        if name not in KNOWN_ARMS and not DEFAULTS_ARM.search(name):
            ignored.append(directory.name)
            continue
        if name in arms:
            raise QueryAdditionsError(f"arm {name} given twice")
        arms[name] = summarize_arm(name, directory, noise)
        for file_name in ("report.json", "gate.json", "traces.jsonl"):
            path = directory / file_name
            if path.is_file():
                inputs.append(InputFile(kind="arm", name=f"{name}/{file_name}", path=repo_relative(path), sha256=_sha256(path)))
    whatsapp = _whatsapp(whatsapp_path) if whatsapp_path is not None else None
    if whatsapp_path is not None:
        inputs.append(InputFile(kind="whatsapp", name="whatsapp", path=repo_relative(whatsapp_path), sha256=_sha256(whatsapp_path)))
    for index, path in enumerate(sorted(tests)):
        inputs.append(InputFile(kind="tests", name=f"tests-{index}", path=repo_relative(path), sha256=_sha256(path)))
    case_info = _cases(cases_path)
    if case_info is not None:
        inputs.append(InputFile(kind="cases", name="lang-detect", path=repo_relative(cases_path), sha256=case_info[1]))
    test_results = _test_results(tests)
    switches, checks = decide(arms, whatsapp, test_results, noise, budgets, case_info)
    resolved_source = source or ("live" if any(arm.tier == "live" for arm in arms.values()) else "fixture")
    return QueryAdditionsReport(
        source=resolved_source,
        noise_floor=noise.floor,
        noise_k=noise.k,
        budgets=budgets,
        inputs=inputs,
        ignored_runs=ignored,
        arms=arms,
        whatsapp=whatsapp,
        tests=test_results,
        switches=switches,
        d31_checklist=checks,
        voice_pairs=_voice_pairs(arms),
        notes=NOTES,
    )


def _voice_pairs(arms: Mapping[str, ArmSummary]) -> dict[str, PairRow]:
    on, off = arms.get("voice-translate"), arms.get("voice-no-translate")
    if on is None or off is None:
        return {}
    pairs = sorted(s for s in set(on.slices) | set(off.slices) if s.startswith(PAIR_PREFIX))
    pick = lambda arm, s: {m: arm.slices.get(s, {}).get(m) for m in RETRIEVAL_METRICS}
    return {s: PairRow(reference=pick(off, s), candidate=pick(on, s)) for s in pairs}


def _redecide(report: QueryAdditionsReport, noise_path: Path, cases_path: Path) -> QueryAdditionsReport:
    """Re-derive switches and checklist from the summaries a committed report carries (the run directories are gitignored)."""
    noise = report_noise(report, noise_path)
    case_input = next((entry for entry in report.inputs if entry.kind == "cases"), None)
    cases = _cases(cases_path) if case_input is not None else None
    switches, checks = decide(report.arms, report.whatsapp, report.tests, noise, report.budgets, cases)
    return report.model_copy(update={"switches": switches, "d31_checklist": checks, "voice_pairs": _voice_pairs(report.arms)})


def report_noise(report: QueryAdditionsReport, noise_path: Path) -> NoiseConfig:
    noise = NoiseConfig.model_validate_json(noise_path.read_text(encoding="utf-8"))
    return noise.model_copy(update={"floor": report.noise_floor, "k": report.noise_k})


def render_markdown(report: QueryAdditionsReport) -> str:
    lines = [
        "# Phase 6.2 query additions: decision report",
        "",
        f"Source: {report.source}. Noise floor {report.noise_floor:g} (k {report.noise_k:g}). Written by `python -m rag_eval.compare query-additions`.",
        "",
        "## Switches",
        "",
        "| Switch | Arm vs reference | Eligible | Improved slices | Regressions | Notes |",
        "|---|---|---|---|---|---|",
    ]
    for s in report.switches:
        lines.append(f"| `{s.name}` | {s.arm} vs {s.reference_arm} | {'yes' if s.eligible else 'no'} | {', '.join(s.improved_slices) or '-'} | {', '.join(s.regressions) or '-'} | {s.notes} |")
    lines += ["", "## D-31 checklist", "", "| Letter | Passed | Evidence |", "|---|---|---|"]
    lines += [f"| {c.letter} | {'yes' if c.passed else 'no'} | {c.evidence} |" for c in report.d31_checklist]
    lines += ["", "## Pre-retrieval latency (D-37)", "", "| Arm | All turns p50/p95 (n) | New variant p95 (n) | No new variant p95 (n) |", "|---|---|---|---|"]

    def cell(stat: StageLatency | None, full: bool = False) -> str:
        if stat is None:
            return "n/a"
        return f"{stat.p50_ms:g}/{stat.p95_ms:g} ({stat.n})" if full else f"{stat.p95_ms:g} ({stat.n})"

    for name, arm in sorted(report.arms.items()):
        pre = arm.latency.pre_retrieval
        lines.append(f"| {name} | {cell(pre.all_turns, True)} | {cell(pre.new_variant)} | {cell(pre.no_new_variant)} |")
    if report.voice_pairs:
        lines += ["", "## Voice cross_lingual per pair", "", "| Pair | Recall@5 off -> on | MRR off -> on |", "|---|---|---|"]
        for pair, row in sorted(report.voice_pairs.items()):
            lines.append(f"| {pair} | {_fmt(row.reference['recall_at_5'])} -> {_fmt(row.candidate['recall_at_5'])} | {_fmt(row.reference['mrr'])} -> {_fmt(row.candidate['mrr'])} |")
    sources = [(name, key, value) for name, arm in sorted(report.arms.items()) for key, value in sorted(arm.language_source_slices.items())]
    if sources:
        lines += ["", "## Language resolved by the LANG-08 chain (P-21, report-only)", "", "| Arm | Slice | Items | Recall@5 | False refusal |", "|---|---|---|---|---|"]
        lines += [f"| {name} | {key} | {v.items} | {_fmt(v.recall_at_5)} | {_fmt(v.false_refusal_rate)} |" for name, key, v in sources]
    if report.ignored_runs:
        lines += ["", f"Ignored run directories: {', '.join(report.ignored_runs)}"]
    lines += ["", "## Notes", "", *[f"- {note}" for note in report.notes], ""]
    return "\n".join(lines)


def _report_text(report: QueryAdditionsReport) -> str:
    return _stable_json(report.model_dump(mode="json"))


def _record(report_text: str, report: QueryAdditionsReport, recorded_at: datetime) -> QueryAdditionsDecisionRecord:
    return QueryAdditionsDecisionRecord(
        recorded_at=recorded_at,
        report_hash=hashlib.sha256(report_text.encode("utf-8")).hexdigest(),
        source=report.source,
        switches=[SwitchDecision(name=s.name, eligible=s.eligible, improved_slices=s.improved_slices, regressions=s.regressions, notes=s.notes) for s in report.switches],
        d31_checklist=report.d31_checklist,
    )


def _read_record(path: Path) -> QueryAdditionsDecisionRecord | None:
    try:
        return QueryAdditionsDecisionRecord.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError):
        return None


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _write(report: QueryAdditionsReport, out: Path, decision: Path, recorded_at: str | None) -> QueryAdditionsDecisionRecord:
    text = _report_text(report)
    previous = _read_record(decision)
    stamp = _parse_time(recorded_at) if recorded_at else datetime.now(UTC).replace(microsecond=0)
    record = _record(text, report, stamp)
    if previous is not None and recorded_at is None and record.model_copy(update={"recorded_at": previous.recorded_at}) == previous:
        record = previous
    _write_text(out / "report.json", text)
    _write_text(out / "report.md", render_markdown(report))
    _write_text(decision, _stable_json(record.model_dump(mode="json")))
    return record


def check(decision: Path, out: Path, noise_path: Path, cases_path: Path, emit: Callable[[str], None]) -> int:
    committed = _read_record(decision)
    if committed is None:
        emit(f"error: {decision} is not a readable QueryAdditionsDecisionRecord")
        return EXIT_INVALID
    try:
        report_text = (out / "report.json").read_text(encoding="utf-8")
        report = QueryAdditionsReport.model_validate_json(report_text)
    except (OSError, ValidationError, ValueError) as exc:
        emit(f"error: {out / 'report.json'}: {exc}")
        return EXIT_INVALID
    problems: list[str] = []
    rebuilt = _redecide(report, noise_path, cases_path)
    runs = [entry for entry in report.inputs if entry.kind == "arm"]
    if runs and all(resolve_cli_path(entry.path).is_file() for entry in runs):
        stale = [entry.path for entry in report.inputs if resolve_cli_path(entry.path).is_file() and _sha256(resolve_cli_path(entry.path)) != entry.sha256]
        if stale:
            problems.append(f"inputs changed since the report: {', '.join(stale)}")
    if _report_text(rebuilt) != report_text:
        problems.append("the committed report differs from its re-derived decisions")
    expected = _record(report_text, rebuilt, committed.recorded_at)
    if expected != committed:
        problems.append("the decision record differs from a fresh derivation (hand-edited or stale)")
    for problem in problems:
        emit(f"stale: {problem}")
    if problems:
        return EXIT_STALE
    emit(f"ok: {decision} re-derived from {out / 'report.json'}")
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.compare query-additions", description="Phase 6.2 decision record from the fixture arms")
    parser.add_argument("--runs", nargs="*", default=[], help="arm run directories (q62-<arm>: report.json, gate.json, traces.jsonl)")
    parser.add_argument("--out", default=DEFAULT_OUT, help="comparison report directory (report.json, report.md)")
    parser.add_argument("--decision", default=DEFAULT_DECISION, help="decision record path")
    parser.add_argument("--tests", nargs="*", default=[], help="vitest JSON reporter outputs with the D-31 test files")
    parser.add_argument("--whatsapp", help="WhatsApp multi-turn report (06.2-12); found in --runs when omitted")
    parser.add_argument("--noise", default=DEFAULT_NOISE)
    parser.add_argument("--budgets", default=DEFAULT_BUDGETS)
    parser.add_argument("--cases", default=DEFAULT_CASES, help="language detection case file (06.2-10)")
    parser.add_argument("--source", choices=("fixture", "live"))
    parser.add_argument("--recorded-at", help="ISO timestamp; default: kept from an equal previous record, else now")
    parser.add_argument("--check", metavar="DECISION", help="re-derive the record from the committed report; exit 1 when stale")
    args = parser.parse_args(argv)
    emit = lambda line: print(line, file=sys.stderr)
    out = _resolve(args.out)
    if args.check:
        return check(_resolve(args.check), out, _resolve(args.noise), _resolve(args.cases), emit)
    if not args.runs:
        emit("error: --runs needs at least one arm directory")
        return EXIT_INVALID
    try:
        report = build_report(
            [_resolve(path) for path in args.runs],
            [_resolve(path) for path in args.tests],
            _resolve(args.noise),
            _resolve(args.budgets),
            _resolve(args.cases),
            _resolve(args.whatsapp) if args.whatsapp else None,
            args.source,
        )
        record = _write(report, out, _resolve(args.decision), args.recorded_at)
    except (QueryAdditionsError, OSError, ValueError) as exc:
        emit(f"error: {exc}")
        return EXIT_INVALID
    eligible = [s.name for s in record.switches if s.eligible]
    print(f"query-additions: {len(eligible)}/{len(record.switches)} switches eligible; checklist {sum(c.passed for c in record.d31_checklist)}/9 passed")
    return EXIT_OK

