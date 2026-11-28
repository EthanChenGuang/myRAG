"""D-17, D-18, A-10: the release regression runner (`python -m rag_eval.regression plan|run|decide`).

Stage A (dev split): every embedding profile x reranker on pgvector, every other switch at its recommended setting.
Stage B (test split): the two best stage-A combinations on pgvector, weaviate and qdrant against the incumbent (the
Phase 4.1 decision defaults plus today's shipped values), then a one-at-a-time ablation of every D-17 switch on the
stage-B winner, then one confirmatory run of the combined defaults.

Ablation and confirmatory configs are registered relative to the stage-B winner: an `ablate.<switch>` config's env holds
the switch at its challenger value (plus the switches it needs, such as the query layer for the framework), and `run`
applies it on top of the winner, flipping the switch back to its incumbent value when the winner already holds the
challenger value; `confirm` is the winner plus every adopted switch. Both are deterministic given the plan and the
stage-B results, so the plan hash pre-registers them (A-10).

Every test-split use is appended to eval/decisions/test-split-ledger.jsonl; a test-split run the plan does not
register needs --reason (Pitfall 12).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.judge import JudgeReport
from rag_sidecar.contracts.latency import LatencyBudgets
from rag_sidecar.contracts.release import (
    BackendComparison,
    DefaultsDecision,
    IncumbentSource,
    RegressionPlan,
    RegressionRunConfig,
    SwitchVerdict,
    TestSplitUse,
)
from rag_sidecar.contracts.report import EvalReport

from rag_eval.harness_runner import HARNESS_SCRIPT, TAIL_LINES, _tail, golden_for_splits
from rag_eval.metrics import CROSS_LINGUAL, language_pair_key
from rag_eval.paired import item_metrics
from rag_eval.paths import REPO_ROOT, repo_relative, resolve_cli_path
from rag_eval.regression_rules import (
    INCUMBENT_BACKEND,
    JUDGE_PRIMARY,
    PAIR_METRICS,
    PAIR_PRIMARY,
    BackendCandidate,
    RuleSettings,
    RunSummary,
    apply_holm,
    decide_backend,
    decide_switch,
    gate_slices,
    latency_ok,
    primary_outcome,
    run_invalid_reason,
)
from rag_eval.release_costs import (
    PRICE_TABLE_PATH,
    PriceTable,
    PriceTableError,
    RunInputs,
    annotate_blocks,
    language_quality,
    languages_below_baseline,
    load_price_table,
    read_ingest_outputs,
    run_languages,
)
from rag_eval.report import RETRIEVAL_TOTAL
from rag_eval.traces import load_traces

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_HARNESS = 3
EXIT_DIFFERS = 1

LEDGER_PATH = REPO_ROOT / "eval" / "decisions" / "test-split-ledger.jsonl"
RECORD_PATH = REPO_ROOT / "eval" / "config" / "release-defaults.json"
DECISIONS_DIR = REPO_ROOT / "eval" / "decisions"
INCUMBENT_PATH = REPO_ROOT / "eval" / "decisions" / "04.1-retrieval-defaults.json"
NOISE_PATH = REPO_ROOT / "eval" / "config" / "noise.json"
BUDGETS_PATH = REPO_ROOT / "eval" / "config" / "latency-budgets.json"
FIXTURE_GOLDEN = REPO_ROOT / "eval" / "fixtures" / "golden.jsonl"
FIXTURE_MARKDOWN = "defaults-fixtures.md"
COST_SECTION = "## Cost, latency and per-language quality"
LANGUAGE_BELOW_BASELINE = "language_below_baseline"
RUN_INDEX = "regression-run.json"
STAGE_A_SUFFIX = ".decision.json"

INCUMBENT_CONFIG = "b.incumbent"
CONFIRM_CONFIG = "confirm"
ABLATE_PREFIX = "ablate."
BACKENDS = ("pgvector", "weaviate", "qdrant")
EXTERNAL_BACKENDS = ("weaviate", "qdrant")
LEGACY_PROFILE = "openai-3-small-1536"
DFLT_VARIABLES = ("RAG_PIPELINE", "RAG_LEXICAL_SEARCH", "RAG_RERANKER", "RAG_REFUSAL_THRESHOLD", "RAG_REFUSAL_FLOOR")
DEFAULT_GATED_PREFIXES = ("overall", "language:", "category:", "pair:")
DEFAULT_MIN_GATE_N = 10
DEFAULT_ALPHA = 0.05
OVERRIDE_KEYS = ("backend", "embedding_profile", "rerank_model")
RETRIEVAL_OVERRIDE_KEYS = ("backend", "rerank_model")
INJECTION_SLICE = "category:injection"
JUDGE_PARTS = ("faithfulness", "answer_relevance")

# Today's shipped value of every variable the regression may move (src/lib/env.ts); the five DFLT variables come from
# the Phase 4.1 decision instead. None of these is a secret.
SHIPPED_DEFAULTS: dict[str, str] = {
    "RAG_PIPELINE": "legacy",
    "RAG_LEXICAL_SEARCH": "false",
    "RAG_RERANKER": "none",
    "RAG_REFUSAL_THRESHOLD": "false",
    "RAG_REFUSAL_FLOOR": "similarity",
    "RAG_CONTEXT_EDGE_ORDER": "false",
    "RAG_CONTEXT_COMPRESSION": "false",
    "RAG_PARENT_CHILD": "false",
    "RAG_HNSW_ITERATIVE_SCAN": "off",
    "RAG_LEXICAL_TRANSLATION": "false",
    "RAG_QUERY_LAYER": "false",
    "RAG_QUERY_FRAMEWORK": "llamaindex",
    "RAG_QUERY_HYDE": "false",
    "RAG_CITATIONS": "false",
    "RAG_GROUNDEDNESS": "false",
    "RAG_CONTEXT_TAGGING": "false",
    "RAG_INJECTION_CHECK": "off",
    "RAG_INGEST_PIPELINE": "legacy",
    "RAG_EMBEDDING_PROFILES": "off",
}

# Phase 5.1's recommended configuration (eval/config/runs/sec-recommended.json); stage A runs every combination with it.
RECOMMENDED_OVERLAY: dict[str, str] = {"RAG_CONTEXT_TAGGING": "true", "RAG_INJECTION_CHECK": "drop"}


@dataclass(frozen=True)
class Ablation:
    switch: str
    values: tuple[str, str]
    requires: Mapping[str, str] = field(default_factory=dict)

    def challenger(self, incumbent: Mapping[str, str]) -> str:
        current = incumbent.get(self.switch, self.values[0])
        return self.values[1] if current == self.values[0] else self.values[0]


# D-17: every switch earlier phases left off by default (values: (off, on)); ingest-time switches go in the env overlay.
ABLATIONS: tuple[Ablation, ...] = (
    Ablation("RAG_PIPELINE", ("legacy", "v2")),
    Ablation("RAG_LEXICAL_SEARCH", ("false", "true")),
    Ablation("RAG_REFUSAL_THRESHOLD", ("false", "true")),
    Ablation("RAG_CONTEXT_EDGE_ORDER", ("false", "true")),
    Ablation("RAG_CONTEXT_COMPRESSION", ("false", "true")),
    Ablation("RAG_PARENT_CHILD", ("false", "true")),
    Ablation("RAG_HNSW_ITERATIVE_SCAN", ("off", "relaxed_order")),
    Ablation("RAG_LEXICAL_TRANSLATION", ("false", "true"), {"RAG_LEXICAL_SEARCH": "true"}),
    Ablation("RAG_QUERY_LAYER", ("false", "true")),
    Ablation("RAG_QUERY_FRAMEWORK", ("llamaindex", "langchain"), {"RAG_QUERY_LAYER": "true"}),
    Ablation("RAG_QUERY_HYDE", ("false", "true"), {"RAG_QUERY_LAYER": "true"}),
    Ablation("RAG_CITATIONS", ("false", "true")),
    Ablation("RAG_GROUNDEDNESS", ("false", "true")),
    Ablation("RAG_CONTEXT_TAGGING", ("false", "true")),
    Ablation("RAG_INJECTION_CHECK", ("off", "drop")),
    Ablation("RAG_INGEST_PIPELINE", ("legacy", "unified")),
    Ablation("RAG_EMBEDDING_PROFILES", ("off", "on")),
)
ABLATION_BY_NAME = {ablation.switch: ablation for ablation in ABLATIONS}

DEFAULT_PROFILES = (LEGACY_PROFILE, "voyage-4-large-1024", "qwen3-8b-1024", "bge-m3-1024")
FIXTURE_PROFILES = (LEGACY_PROFILE, "bge-m3-1024")
DEFAULT_RERANKERS = ("none", "local_bm25", "auto", "cohere", "voyage")
FIXTURE_RERANKERS = ("none", "local_bm25", "auto", "cohere:fake-quality-v1")
FIXTURE_KEY_PLACEHOLDER = "fixture"


class RegressionError(Exception):
    def __init__(self, message: str, code: int = EXIT_USAGE) -> None:
        super().__init__(message)
        self.code = code


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class StageARank(_Model):
    config_name: str
    score: float | None
    eligible: bool
    reason: str


class StageADecision(_Model):
    """The stage-A ranking on the dev split; stage B registers its top two configurations."""

    schema_version: Literal[1] = 1
    plan_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    primary_metric: str
    decided_at: str
    ranking: list[StageARank]
    top: list[RegressionRunConfig] = Field(min_length=1, max_length=2)


class LedgerLine(TestSplitUse):
    """One test-split use plus the golden set and split it read."""

    golden_set: Literal["fixtures", "private"]
    split: Literal["test"]

    def use(self) -> TestSplitUse:
        return TestSplitUse.model_validate(self.model_dump(exclude={"golden_set", "split"}))


class RunEntry(_Model):
    config: RegressionRunConfig
    sha256: str
    out_dir: str
    status: Literal["ran", "skipped"]
    skip_reason: str | None = None
    registered: bool = True


class RunIndex(_Model):
    plan_sha256: str
    entries: dict[str, RunEntry] = Field(default_factory=dict)


@dataclass(frozen=True)
class RunArtifacts:
    report: EvalReport
    traces: list[RagTrace]
    manifest: dict[str, Any] | None = None
    judge: JudgeReport | None = None


class HarnessRunner(Protocol):
    def __call__(
        self, config: RegressionRunConfig, *, split: str, golden: Sequence[Path], out_dir: Path
    ) -> RunArtifacts: ...


Clock = Callable[[], str]


def utc_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def config_sha256(config: RegressionRunConfig) -> str:
    payload = json.dumps(config.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RegressionError(f"cannot read {path}: {exc}") from exc


def _validate(model: type[BaseModel], path: Path) -> Any:
    try:
        return model.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        raise RegressionError(f"{path} is not a valid {model.__name__}: {exc}") from exc


# ---------------------------------------------------------------- incumbent


@dataclass(frozen=True)
class Incumbent:
    env: dict[str, str]
    source: IncumbentSource


def load_incumbent(path: Path = INCUMBENT_PATH) -> Incumbent:
    """Today's shipped values, with the Phase 4.1 decision's five DFLT values only when that decision flipped
    (status == "flip", as scripts/check-config.mjs reads it); a not_flipped record is a failed proposal, not the incumbent."""
    try:
        raw = path.read_bytes()
        record = json.loads(raw)
        status = record["status"]
        defaults = record["defaults"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise RegressionError(f"the incumbent decision {path} is missing or malformed: {exc}") from exc
    if status not in ("flip", "not_flipped"):
        raise RegressionError(f"the incumbent decision {path} has status {status!r}, expected flip or not_flipped")
    missing = [name for name in DFLT_VARIABLES if not isinstance(defaults.get(name), str)]
    if missing:
        raise RegressionError(f"the incumbent decision {path} lacks {', '.join(missing)}")
    env = dict(SHIPPED_DEFAULTS)
    if status == "flip":
        env.update({name: defaults[name] for name in DFLT_VARIABLES})
    source = IncumbentSource(path="eval/decisions/04.1-retrieval-defaults.json", sha256=hashlib.sha256(raw).hexdigest())
    return Incumbent(env=env, source=source)


# ---------------------------------------------------------------- plan


def _slug(value: str) -> str:
    return "".join(char if char.isalnum() or char in "._-" else "-" for char in value.lower())


def _reranker_parts(spec: str) -> tuple[str, str | None]:
    provider, _, model = spec.partition(":")
    return provider, (model or None)


def _combo_config(profile: str, reranker: str, base_env: Mapping[str, str], fixtures: bool) -> RegressionRunConfig:
    provider, model = _reranker_parts(reranker)
    env = dict(base_env)
    env["RAG_RERANKER"] = provider
    if profile != LEGACY_PROFILE:
        env["RAG_EMBEDDING_PROFILES"] = "on"
        env["RAG_PIPELINE"] = "v2"
    if fixtures and provider == "cohere" and model and model.startswith("fake-"):
        env["COHERE_API_KEY"] = FIXTURE_KEY_PLACEHOLDER
    overrides: dict[str, str] = {"backend": INCUMBENT_BACKEND, "embedding_profile": profile}
    if model:
        overrides["rerank_model"] = model
    return RegressionRunConfig(name=f"a.{_slug(profile)}.{_slug(reranker)}", env=env, overrides=overrides)


def plan_stage_a(
    incumbent: Incumbent,
    *,
    profiles: Sequence[str],
    rerankers: Sequence[str],
    fixtures: bool,
    judge: bool,
    gated_slice_prefixes: Sequence[str],
    min_gate_n: int,
    alpha: float,
    clock: Clock = utc_now,
) -> RegressionPlan:
    base_env = {**incumbent.env, **RECOMMENDED_OVERLAY}
    incumbent_reranker = incumbent.env["RAG_RERANKER"]
    rerankers = list(dict.fromkeys([*rerankers, incumbent_reranker]))
    profiles = list(dict.fromkeys([LEGACY_PROFILE, *profiles]))
    configs = [_combo_config(profile, reranker, base_env, fixtures) for profile in profiles for reranker in rerankers]
    incumbent_name = _combo_config(LEGACY_PROFILE, incumbent_reranker, base_env, fixtures).name
    return RegressionPlan(
        stage="a",
        split="dev",
        primary_metric=JUDGE_PRIMARY if judge else PAIR_PRIMARY,
        configs=configs,
        incumbent_config=incumbent_name,
        gated_slice_prefixes=list(gated_slice_prefixes),
        alpha=alpha,
        min_gate_n=min_gate_n,
        test_split_budget=0,
        created_at=clock(),
    )


def ablation_config(ablation: Ablation, incumbent_env: Mapping[str, str]) -> RegressionRunConfig:
    env = {**ablation.requires, ablation.switch: ablation.challenger(incumbent_env)}
    return RegressionRunConfig(name=f"{ABLATE_PREFIX}{ablation.switch.lower()}", env=env)


def plan_stage_b(
    incumbent: Incumbent,
    stage_a: StageADecision,
    *,
    judge: bool,
    gated_slice_prefixes: Sequence[str],
    min_gate_n: int,
    alpha: float,
    clock: Clock = utc_now,
) -> RegressionPlan:
    configs = [
        RegressionRunConfig(
            name=INCUMBENT_CONFIG,
            env=dict(incumbent.env),
            overrides={"backend": INCUMBENT_BACKEND, "embedding_profile": LEGACY_PROFILE},
        )
    ]
    for index, combo in enumerate(stage_a.top, start=1):
        for backend in BACKENDS:
            configs.append(
                RegressionRunConfig(
                    name=f"b.{backend}.c{index}", env=dict(combo.env), overrides={**combo.overrides, "backend": backend}
                )
            )
    configs.extend(ablation_config(ablation, incumbent.env) for ablation in ABLATIONS)
    configs.append(RegressionRunConfig(name=CONFIRM_CONFIG))
    return RegressionPlan(
        stage="b",
        split="test",
        primary_metric=JUDGE_PRIMARY if judge else PAIR_PRIMARY,
        configs=configs,
        incumbent_config=INCUMBENT_CONFIG,
        gated_slice_prefixes=list(gated_slice_prefixes),
        alpha=alpha,
        min_gate_n=min_gate_n,
        test_split_budget=len(configs),
        created_at=clock(),
    )


# ---------------------------------------------------------------- run summaries


def _slices_of(report: EvalReport) -> dict[str, tuple[str, ...]]:
    slices: dict[str, tuple[str, ...]] = {}
    for item in report.items:
        names = ["overall", f"language:{item.language}", f"category:{item.category}"]
        if item.category == CROSS_LINGUAL and item.evidence_language is not None:
            names.append(f"pair:{language_pair_key(item.language, item.evidence_language)}")
        slices[item.item_id] = tuple(names)
    return slices


def _judge_scores(judge: JudgeReport | None) -> dict[str, float]:
    if judge is None:
        return {}
    by_item: dict[str, list[float]] = {}
    for score in judge.items:
        if score.metric in JUDGE_PARTS and score.score is not None:
            by_item.setdefault(score.item_id, []).append(score.score)
    return {item_id: math.fsum(values) / len(values) for item_id, values in by_item.items()}


def _backend_impl(manifest: Mapping[str, Any] | None) -> str | None:
    if not manifest:
        return None
    if isinstance(manifest.get("backend_impl"), str):
        return manifest["backend_impl"]
    for value in manifest.values():
        if isinstance(value, Mapping) and isinstance(value.get("backend_impl"), str):
            return value["backend_impl"]
    return None


def summarize(config: RegressionRunConfig, artifacts: RunArtifacts) -> RunSummary:
    report = artifacts.report
    judge = _judge_scores(artifacts.judge)
    metrics: dict[str, dict[str, float | None]] = {}
    for item in report.items:
        values: dict[str, float | None] = dict(item_metrics(item))
        if item.item_id in judge:
            values[JUDGE_PRIMARY] = judge[item.item_id]
        metrics[item.item_id] = values
    latency: dict[str, float | None] = {}
    pre = report.pre_generation or {}
    if "chat" in pre:
        latency["chat"] = pre["chat"].p95_ms
    elif report.latency and RETRIEVAL_TOTAL in report.latency:
        latency["chat"] = report.latency[RETRIEVAL_TOTAL].p95_ms
    if "voice" in pre:
        latency["voice"] = pre["voice"].p95_ms
    asr: float | None = None
    if report.injection is not None:
        rate = report.injection.attack_success_rate.get(INJECTION_SLICE)
        asr = rate.value if rate is not None else None
    fallbacks: dict[str, int] = {}
    for trace in artifacts.traces:
        backend = trace.retrieval_backend
        if backend is not None and backend.fallback_reason is not None:
            fallbacks[backend.fallback_reason] = fallbacks.get(backend.fallback_reason, 0) + 1
    return RunSummary(
        config_name=config.name,
        metrics=metrics,
        slices=_slices_of(report),
        latency_p95_ms=latency,
        injection_asr=asr,
        fallbacks=fallbacks,
        backend=str(config.overrides.get("backend", INCUMBENT_BACKEND)),
        backend_impl=_backend_impl(artifacts.manifest),
    )


def load_artifacts(out_dir: Path) -> RunArtifacts:
    try:
        report = EvalReport.model_validate_json((out_dir / "report.json").read_text(encoding="utf-8"))
        traces_path = out_dir / "traces.jsonl"
        traces = load_traces(traces_path) if traces_path.is_file() else []
    except (OSError, ValidationError, ValueError) as exc:
        raise RegressionError(f"run outputs in {out_dir} are unreadable: {exc}") from exc
    manifest_path = out_dir / "run.json"
    manifest = _read_json(manifest_path) if manifest_path.is_file() else None
    judge_path = out_dir / "judge.json"
    judge = _validate(JudgeReport, judge_path) if judge_path.is_file() else None
    return RunArtifacts(report=report, traces=traces, manifest=manifest, judge=judge)


# ---------------------------------------------------------------- stage logic


def _merge(base: RegressionRunConfig, name: str, env: Mapping[str, str], overrides: Mapping[str, Any] | None = None) -> RegressionRunConfig:
    return RegressionRunConfig(name=name, env={**base.env, **env}, overrides={**base.overrides, **(overrides or {})})


def _same_settings(left: RegressionRunConfig, right: RegressionRunConfig) -> bool:
    return left.env == right.env and left.overrides == right.overrides


def incoherent_reason(config: RegressionRunConfig) -> str | None:
    profile = config.overrides.get("embedding_profile", LEGACY_PROFILE)
    if profile != LEGACY_PROFILE and (config.env.get("RAG_EMBEDDING_PROFILES") != "on" or config.env.get("RAG_PIPELINE") != "v2"):
        return "required_by_embedding_profile"
    return None


def _score(summary: RunSummary) -> float | None:
    metrics = (JUDGE_PRIMARY,) if any(JUDGE_PRIMARY in values for values in summary.metrics.values()) else PAIR_METRICS
    means: list[float] = []
    for metric in metrics:
        values = [row[metric] for row in summary.metrics.values() if row.get(metric) is not None]
        if values:
            means.append(math.fsum(values) / len(values))
    return math.fsum(means) / len(means) if means else None


def rank_stage_a(plan: RegressionPlan, summaries: Mapping[str, RunSummary], settings: RuleSettings) -> list[StageARank]:
    ranking: list[StageARank] = []
    for config in plan.configs:
        summary = summaries.get(config.name)
        if summary is None:
            ranking.append(StageARank(config_name=config.name, score=None, eligible=False, reason="not_run"))
            continue
        score = _score(summary)
        if run_invalid_reason(summary):
            reason = "run_invalid"
        elif summary.injection_asr is not None and summary.injection_asr > 0:
            reason = "injection_attack_success"
        elif not latency_ok(summary, settings):
            reason = "latency_over_budget"
        elif score is None:
            reason = "no_primary_values"
        else:
            reason = "eligible"
        ranking.append(StageARank(config_name=config.name, score=score, eligible=reason == "eligible", reason=reason))
    return sorted(ranking, key=lambda row: (not row.eligible, -(row.score or 0.0), row.config_name))


@dataclass(frozen=True)
class ComboVerdict:
    config_name: str
    adopted: bool
    reason: str
    delta: float | None
    band: float


def _combo_verdict(challenger: RunSummary, incumbent: RunSummary, settings: RuleSettings) -> ComboVerdict:
    primary = primary_outcome(challenger, incumbent, settings)
    if run_invalid_reason(challenger):
        reason = "run_invalid"
    elif challenger.injection_asr is None:
        reason = "injection_not_measured"
    elif challenger.injection_asr > 0:
        reason = "injection_attack_success"
    elif not latency_ok(challenger, settings):
        reason = "latency_over_budget"
    elif not gate_slices(challenger, incumbent, settings).ok:
        reason = "slice_regression"
    elif primary.gain:
        reason = "gain_beyond_band"
    else:
        reason = "no_gain_beyond_band"
    return ComboVerdict(challenger.config_name, reason == "gain_beyond_band", reason, primary.chosen.delta, primary.chosen.band)


@dataclass(frozen=True)
class StageBBase:
    winner: str
    combo: int | None
    combos: list[ComboVerdict]
    backend: BackendComparison


def resolve_stage_b_base(
    plan: RegressionPlan,
    summaries: Mapping[str, RunSummary],
    settings: RuleSettings,
    notes: Mapping[str, Mapping[str, str]],
    *,
    fixtures: bool,
) -> StageBBase:
    incumbent = summaries[INCUMBENT_CONFIG]
    combo_indexes = sorted({int(config.name.rsplit(".c", 1)[1]) for config in plan.configs if config.name.startswith("b.pgvector.c")})
    combos = [
        _combo_verdict(summaries[f"b.pgvector.c{index}"], incumbent, settings)
        for index in combo_indexes
        if f"b.pgvector.c{index}" in summaries
    ]
    adopted = [(verdict, index) for verdict, index in zip(combos, combo_indexes, strict=False) if verdict.adopted]
    chosen = max(adopted, key=lambda entry: (entry[0].delta or 0.0, -entry[1]))[1] if adopted else None
    reference = chosen if chosen is not None else (combo_indexes[0] if combo_indexes else None)
    if reference is None or f"b.pgvector.c{reference}" not in summaries:
        raise RegressionError("stage B needs the pgvector run of at least one stage-A combination")
    candidates = [
        BackendCandidate(
            backend=backend,  # type: ignore[arg-type]
            run=summaries[f"b.{backend}.c{reference}"],
            cost_note=notes.get(backend, {}).get("cost_note"),
            operational_note=notes.get(backend, {}).get("operational_note"),
        )
        for backend in EXTERNAL_BACKENDS
        if f"b.{backend}.c{reference}" in summaries
    ]
    if not candidates:
        raise RegressionError("stage B needs at least one external backend run")
    comparison = decide_backend(summaries[f"b.pgvector.c{reference}"], candidates, settings)
    if comparison.winner != INCUMBENT_BACKEND and chosen is None:
        comparison = comparison.model_copy(update={"winner": INCUMBENT_BACKEND, "reason": "no_combo_adopted"})
    if comparison.winner != INCUMBENT_BACKEND and fixtures:
        comparison = comparison.model_copy(update={"winner": INCUMBENT_BACKEND, "reason": "fixture_record_keeps_pgvector"})
    comparison = BackendComparison.model_validate(comparison.model_dump())
    winner = f"b.{comparison.winner}.c{chosen}" if chosen is not None else INCUMBENT_CONFIG
    return StageBBase(winner=winner, combo=chosen, combos=combos, backend=comparison)


@dataclass(frozen=True)
class ResolvedAblation:
    ablation: Ablation
    registered: RegressionRunConfig
    run_config: RegressionRunConfig | None
    comparator_settings: RegressionRunConfig | None
    challenger_is_run: bool
    skip_reason: str | None


def resolve_ablation(
    registered: RegressionRunConfig, winner: RegressionRunConfig, incumbent_env: Mapping[str, str]
) -> ResolvedAblation:
    switch = next(name for name in registered.env if name.lower() == registered.name[len(ABLATE_PREFIX):])
    ablation = ABLATION_BY_NAME[switch]
    challenger_value = registered.env[switch]
    requires = {name: value for name, value in registered.env.items() if name != switch}
    base = _merge(winner, registered.name, requires)
    incumbent_value = incumbent_env.get(switch, ablation.values[0])
    if incumbent_value == challenger_value:
        incumbent_value = ablation.values[0] if challenger_value == ablation.values[1] else ablation.values[1]
    challenger_is_run = base.env.get(switch) != challenger_value
    flipped = _merge(base, registered.name, {switch: challenger_value if challenger_is_run else incumbent_value})
    skip = incoherent_reason(flipped) or incoherent_reason(base)
    return ResolvedAblation(ablation, registered, None if skip else flipped, None if skip else base, challenger_is_run, skip)


def resolve_confirm(winner: RegressionRunConfig, verdicts: Sequence[SwitchVerdict]) -> RegressionRunConfig:
    env: dict[str, str] = {}
    for verdict in verdicts:
        if verdict.decision == "adopt":
            env.update(ABLATION_BY_NAME[verdict.switch].requires)
            env[verdict.switch] = verdict.value
    return _merge(winner, CONFIRM_CONFIG, env)


def ablation_verdicts(
    resolved: Sequence[ResolvedAblation],
    run_configs: Mapping[str, RegressionRunConfig],
    summaries: Mapping[str, RunSummary],
    winner_name: str,
    settings: RuleSettings,
) -> tuple[list[SwitchVerdict], list[tuple[str, str]]]:
    verdicts: list[SwitchVerdict] = []
    skipped: list[tuple[str, str]] = []
    for entry in resolved:
        if entry.run_config is None:
            skipped.append((entry.ablation.switch, entry.skip_reason or "skipped"))
            continue
        comparator = next(
            (
                name
                for name in [winner_name, *(item.registered.name for item in resolved)]
                if name != entry.registered.name
                and name in run_configs
                and entry.comparator_settings is not None
                and _same_settings(run_configs[name], entry.comparator_settings)
            ),
            None,
        )
        run_summary = summaries.get(entry.registered.name)
        if comparator is None or comparator not in summaries or run_summary is None:
            skipped.append((entry.ablation.switch, "no_comparator"))
            continue
        challenger, incumbent = (run_summary, summaries[comparator]) if entry.challenger_is_run else (summaries[comparator], run_summary)
        value = entry.registered.env[entry.ablation.switch]
        verdicts.append(decide_switch(entry.ablation.switch, value, challenger, incumbent, settings))
    return apply_holm(verdicts, settings), skipped


def confirm_holds(confirm: RunSummary, incumbent: RunSummary, settings: RuleSettings) -> tuple[bool, str]:
    if run_invalid_reason(confirm):
        return False, "run_invalid"
    if confirm.injection_asr is None or confirm.injection_asr > 0:
        return False, "injection_attack_success" if confirm.injection_asr else "injection_not_measured"
    if not latency_ok(confirm, settings):
        return False, "latency_over_budget"
    if not gate_slices(confirm, incumbent, settings).ok:
        return False, "slice_regression"
    if primary_outcome(confirm, incumbent, settings).loss:
        return False, "primary_loss"
    return True, "every_gate_held"


# ---------------------------------------------------------------- ledger and index


def read_ledger(path: Path) -> list[LedgerLine]:
    if not path.is_file():
        return []
    lines: list[LedgerLine] = []
    for number, text in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not text.strip():
            continue
        try:
            lines.append(LedgerLine.model_validate_json(text))
        except ValidationError as exc:
            raise RegressionError(f"{path}:{number}: invalid ledger line: {exc}") from exc
    return lines


def append_ledger(path: Path, line: LedgerLine) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(line.model_dump(mode="json", exclude_none=True), sort_keys=True, ensure_ascii=False) + "\n")


def read_index(runs_dir: Path, plan_sha: str) -> RunIndex:
    path = runs_dir / RUN_INDEX
    if not path.is_file():
        return RunIndex(plan_sha256=plan_sha)
    index = _validate(RunIndex, path)
    if index.plan_sha256 != plan_sha:
        raise RegressionError(f"{path} belongs to plan {index.plan_sha256}, not {plan_sha}")
    return index


def write_index(runs_dir: Path, index: RunIndex) -> None:
    _write_text(runs_dir / RUN_INDEX, index.model_dump_json(indent=2) + "\n")


# ---------------------------------------------------------------- run


@dataclass
class RunContext:
    plan: RegressionPlan
    plan_sha: str
    runs_dir: Path
    runner: HarnessRunner
    golden: list[Path]
    golden_set: Literal["fixtures", "private"]
    ledger: Path
    settings: RuleSettings
    incumbent_env: dict[str, str]
    notes: Mapping[str, Mapping[str, str]]
    fixtures: bool
    clock: Clock
    reason: str | None = None
    confirm_env: Callable[[RegressionRunConfig], bool] | None = None
    index: RunIndex = field(init=False)
    summaries: dict[str, RunSummary] = field(default_factory=dict)
    log: Callable[[str], None] = print

    def __post_init__(self) -> None:
        self.index = read_index(self.runs_dir, self.plan_sha)

    def record_use(self, config: RegressionRunConfig, *, registered: bool) -> None:
        if self.plan.split != "test":
            return
        uses = [line for line in read_ledger(self.ledger) if line.plan_sha256 == self.plan_sha]
        line = LedgerLine(
            run_id=f"{self.plan_sha[:12]}-{config.name}-{len(uses) + 1}"[:128],
            config_name=config.name,
            plan_sha256=self.plan_sha,
            used_at=self.clock(),
            registered=registered,
            reason=None if registered else self.reason,
            golden_set=self.golden_set,
            split="test",
        )
        append_ledger(self.ledger, line)

    def execute(self, config: RegressionRunConfig, *, registered: bool = True, force: bool = False) -> RunSummary | None:
        existing = self.index.entries.get(config.name)
        if existing is not None and existing.status == "ran" and not force:
            summary = summarize(existing.config, load_artifacts(Path(existing.out_dir)))
            self.summaries[config.name] = summary
            return summary
        out_dir = self.runs_dir / config.name
        if self.confirm_env is not None and not self.confirm_env(config):
            raise RegressionError(f"the environment for {config.name} was not confirmed; nothing ran")
        self.record_use(config, registered=registered)
        self.log(f"regression: running {config.name} on the {self.plan.split} split")
        artifacts = self.runner(config, split=self.plan.split, golden=self.golden, out_dir=out_dir)
        summary = summarize(config, artifacts)
        self.summaries[config.name] = summary
        entries = dict(self.index.entries)
        entries[config.name] = RunEntry(
            config=config, sha256=config_sha256(config), out_dir=str(out_dir), status="ran", registered=registered
        )
        self.index = RunIndex(plan_sha256=self.plan_sha, entries=entries)
        write_index(self.runs_dir, self.index)
        return summary

    def skip(self, config: RegressionRunConfig, reason: str) -> None:
        entries = dict(self.index.entries)
        entries[config.name] = RunEntry(
            config=config, sha256=config_sha256(config), out_dir=str(self.runs_dir / config.name), status="skipped", skip_reason=reason
        )
        self.index = RunIndex(plan_sha256=self.plan_sha, entries=entries)
        write_index(self.runs_dir, self.index)
        self.log(f"regression: skipped {config.name} ({reason})")


def run_plan(ctx: RunContext, *, rerun: Sequence[str] = (), extra: Sequence[RegressionRunConfig] = ()) -> None:
    registered_names = {config.name for config in ctx.plan.configs}
    if ctx.plan.split == "test" and ctx.reason is None:
        unregistered = [config.name for config in extra]
        repeated = [name for name in rerun if name in ctx.index.entries and ctx.index.entries[name].status == "ran"]
        if unregistered or repeated:
            raise RegressionError(
                "a test-split run outside the registered plan needs --reason: "
                + ", ".join([*(f"{name} (not registered)" for name in unregistered), *(f"{name} (already used)" for name in repeated)])
            )
    unknown = [name for name in rerun if name not in registered_names]
    if unknown:
        raise RegressionError(f"--rerun names configs outside the plan: {', '.join(unknown)}")
    for config in extra:
        ctx.execute(config, registered=False, force=True)
    forced = set(rerun)
    if ctx.plan.stage == "a":
        for config in ctx.plan.configs:
            ctx.execute(config, force=config.name in forced, registered=config.name not in forced)
        return
    base_configs = [config for config in ctx.plan.configs if not config.name.startswith(ABLATE_PREFIX) and config.name != CONFIRM_CONFIG]
    for config in base_configs:
        ctx.execute(config, force=config.name in forced, registered=config.name not in forced)
    run_stage_b_tail(ctx, forced)


def _winner_config(plan: RegressionPlan, name: str) -> RegressionRunConfig:
    return next(config for config in plan.configs if config.name == name)


def run_stage_b_tail(ctx: RunContext, forced: set[str]) -> None:
    base = resolve_stage_b_base(ctx.plan, ctx.summaries, ctx.settings, ctx.notes, fixtures=ctx.fixtures)
    winner = _winner_config(ctx.plan, base.winner)
    resolved = [
        resolve_ablation(config, winner, ctx.incumbent_env) for config in ctx.plan.configs if config.name.startswith(ABLATE_PREFIX)
    ]
    run_configs: dict[str, RegressionRunConfig] = {base.winner: winner}
    for entry in resolved:
        if entry.run_config is None:
            ctx.skip(entry.registered, entry.skip_reason or "skipped")
            continue
        run_configs[entry.registered.name] = entry.run_config
        ctx.execute(entry.run_config, force=entry.registered.name in forced, registered=entry.registered.name not in forced)
    verdicts, _ = ablation_verdicts(resolved, run_configs, ctx.summaries, base.winner, ctx.settings)
    executed = {INCUMBENT_CONFIG: _winner_config(ctx.plan, INCUMBENT_CONFIG), **run_configs}
    verdicts = apply_language_rule(verdicts, executed, ctx.summaries, base.winner, ctx.settings)
    confirm = resolve_confirm(winner, verdicts)
    ctx.execute(confirm, force=CONFIRM_CONFIG in forced, registered=CONFIRM_CONFIG not in forced)


# ---------------------------------------------------------------- decide


@dataclass(frozen=True)
class StageBOutcome:
    decision: DefaultsDecision
    base: StageBBase
    skipped: list[tuple[str, str]]
    confirm_ok: bool
    confirm_reason: str
    invalid_runs: list[tuple[str, str]]
    run_configs: dict[str, RegressionRunConfig]


def _summaries_from_index(index: RunIndex) -> tuple[dict[str, RunSummary], dict[str, RegressionRunConfig]]:
    summaries: dict[str, RunSummary] = {}
    configs: dict[str, RegressionRunConfig] = {}
    for name, entry in index.entries.items():
        if entry.status != "ran":
            continue
        configs[name] = entry.config
        summaries[name] = summarize(entry.config, load_artifacts(Path(entry.out_dir)))
    return summaries, configs


def load_run_inputs(index: RunIndex) -> dict[str, RunInputs]:
    runs: dict[str, RunInputs] = {}
    for name, entry in index.entries.items():
        if entry.status != "ran":
            continue
        out_dir = Path(entry.out_dir)
        artifacts = load_artifacts(out_dir)
        documents, usage = read_ingest_outputs(out_dir)
        runs[name] = RunInputs(
            name=name,
            env=dict(entry.config.env),
            backend=str(entry.config.overrides.get("backend", INCUMBENT_BACKEND)),
            embedding_profile=str(entry.config.overrides.get("embedding_profile", LEGACY_PROFILE)),
            report=artifacts.report,
            traces=artifacts.traces,
            summary=summarize(entry.config, artifacts),
            ingest_documents=documents,
            ingest_usage=usage,
        )
    return runs


def _reranker_of(run: RunInputs, overrides_model: Any) -> str:
    provider = run.env.get("RAG_RERANKER", "none")
    return f"{provider}:{overrides_model}" if overrides_model else provider


def adopted_config_name(record: DefaultsDecision, runs: Mapping[str, RunInputs], index: RunIndex | None = None) -> str:
    """The run that measured the record's defaults: the confirmatory run when a switch was adopted, else the stage-B
    config whose profile, reranker and backend the record names (the incumbent when it matches)."""
    if any(verdict.decision == "adopt" for verdict in record.verdicts) and CONFIRM_CONFIG in runs:
        return CONFIRM_CONFIG
    models = {name: entry.config.overrides.get("rerank_model") for name, entry in (index.entries.items() if index else ())}
    candidates = [
        name
        for name, run in sorted(runs.items())
        if not name.startswith(ABLATE_PREFIX)
        and name != CONFIRM_CONFIG
        and run.embedding_profile == record.embedding_profile
        and run.backend == record.backend
        and (index is None or _reranker_of(run, models.get(name)) == record.reranker)
    ]
    if INCUMBENT_CONFIG in candidates or not candidates:
        return INCUMBENT_CONFIG
    return candidates[0]


@dataclass(frozen=True)
class AnnotationInputs:
    prices: PriceTable
    budgets: LatencyBudgets
    budgets_sha256: str


def _check_incumbent_run(executed: Mapping[str, RegressionRunConfig], incumbent: Incumbent) -> None:
    run = executed.get(INCUMBENT_CONFIG)
    if run is None:
        return
    differing = [name for name in DFLT_VARIABLES if run.env.get(name) != incumbent.env.get(name)]
    if differing:
        raise RegressionError(
            f"the incumbent run {INCUMBENT_CONFIG} is not the Phase 4.1 decision for {', '.join(differing)} "
            f"({incumbent.source.path})"
        )


def apply_language_rule(
    verdicts: Sequence[SwitchVerdict],
    executed: Mapping[str, RegressionRunConfig],
    summaries: Mapping[str, RunSummary],
    winner_name: str,
    settings: RuleSettings,
) -> list[SwitchVerdict]:
    """ADM-02: an adopted switch whose run leaves an enabled language below the incumbent's value keeps the incumbent."""
    incumbent = summaries[INCUMBENT_CONFIG]
    languages = run_languages(incumbent, executed[INCUMBENT_CONFIG].env if INCUMBENT_CONFIG in executed else None)
    result: list[SwitchVerdict] = []
    for verdict in verdicts:
        if verdict.decision != "adopt":
            result.append(verdict)
            continue
        name = f"{ABLATE_PREFIX}{verdict.switch.lower()}"
        config = executed.get(name)
        holder = name if config is not None and config.env.get(verdict.switch) == verdict.value else winner_name
        challenger = summaries.get(holder)
        rows = language_quality(challenger, incumbent, languages, settings) if challenger is not None else []
        if languages_below_baseline(rows):
            verdict = SwitchVerdict.model_validate(
                {**verdict.model_dump(), "decision": "keep_incumbent", "reason": LANGUAGE_BELOW_BASELINE}
            )
        result.append(verdict)
    return result


def decide_stage_a(plan: RegressionPlan, plan_sha: str, index: RunIndex, settings: RuleSettings, clock: Clock) -> StageADecision:
    summaries, _ = _summaries_from_index(index)
    ranking = rank_stage_a(plan, summaries, settings)
    top_names = [row.config_name for row in ranking if row.eligible][:2]
    if not top_names:
        raise RegressionError("no stage-A combination is eligible; stage B has nothing to register")
    by_name = {config.name: config for config in plan.configs}
    return StageADecision(
        plan_sha256=plan_sha,
        primary_metric=plan.primary_metric,
        decided_at=clock(),
        ranking=ranking,
        top=[by_name[name] for name in top_names],
    )


def decide_stage_b(
    plan: RegressionPlan,
    plan_sha: str,
    index: RunIndex,
    settings: RuleSettings,
    incumbent: Incumbent,
    ledger: Sequence[LedgerLine],
    notes: Mapping[str, Mapping[str, str]],
    *,
    fixtures: bool,
    clock: Clock,
    annotation: AnnotationInputs | None = None,
) -> StageBOutcome:
    summaries, executed = _summaries_from_index(index)
    if INCUMBENT_CONFIG not in summaries:
        raise RegressionError(f"the incumbent run {INCUMBENT_CONFIG} is missing; run the plan first")
    _check_incumbent_run(executed, incumbent)
    base = resolve_stage_b_base(plan, summaries, settings, notes, fixtures=fixtures)
    winner = _winner_config(plan, base.winner)
    resolved = [resolve_ablation(config, winner, incumbent.env) for config in plan.configs if config.name.startswith(ABLATE_PREFIX)]
    run_configs = {base.winner: winner, **{name: config for name, config in executed.items() if name.startswith(ABLATE_PREFIX)}}
    verdicts, skipped = ablation_verdicts(resolved, run_configs, summaries, base.winner, settings)
    verdicts = apply_language_rule(verdicts, executed, summaries, base.winner, settings)
    confirm_ok, confirm_reason = False, "confirmatory_run_missing"
    if CONFIRM_CONFIG in summaries:
        expected = resolve_confirm(winner, verdicts)
        if not _same_settings(expected, executed[CONFIRM_CONFIG]):
            confirm_reason = "confirmatory_run_stale"
        else:
            confirm_ok, confirm_reason = confirm_holds(summaries[CONFIRM_CONFIG], summaries[INCUMBENT_CONFIG], settings)
    if not confirm_ok:
        verdicts = [
            SwitchVerdict.model_validate({**verdict.model_dump(), "decision": "keep_incumbent", "reason": "confirmatory_failed"})
            if verdict.decision == "adopt"
            else verdict
            for verdict in verdicts
        ]
    final_env = dict(winner.env)
    for verdict in verdicts:
        if verdict.decision == "adopt":
            final_env.update(ABLATION_BY_NAME[verdict.switch].requires)
            final_env[verdict.switch] = verdict.value
    defaults = {name: final_env.get(name, value) for name, value in incumbent.env.items()}
    provider = winner.env.get("RAG_RERANKER", incumbent.env["RAG_RERANKER"])
    model = winner.overrides.get("rerank_model")
    plan_uses = [line.use() for line in ledger if line.plan_sha256 == plan_sha]
    invalid_runs = sorted(
        (name, reason) for name, summary in summaries.items() if (reason := run_invalid_reason(summary)) is not None
    )
    fields: dict[str, Any] = {
        "provisional": "fixtures" if fixtures else None,
        "decided_at": clock(),
        "plan_sha256": plan_sha,
        "primary_metric": plan.primary_metric,
        "incumbent_source": incumbent.source,
        "incumbent": dict(incumbent.env),
        "defaults": defaults,
        "embedding_profile": str(winner.overrides.get("embedding_profile", LEGACY_PROFILE)),
        "reranker": f"{provider}:{model}" if model else provider,
        "backend": base.backend.winner,
        "verdicts": verdicts,
        "backend_comparison": base.backend,
        "config_hashes": {name: entry.sha256 for name, entry in sorted(index.entries.items()) if entry.status == "ran"},
        "test_split_uses": plan_uses,
    }
    if annotation is None:
        decision = DefaultsDecision(**fields)
    else:
        decision = annotate_decision(DefaultsDecision.model_construct(**fields), index, settings, annotation)
    return StageBOutcome(decision, base, skipped, confirm_ok, confirm_reason, invalid_runs, executed)


def annotate_decision(
    record: DefaultsDecision, index: RunIndex, settings: RuleSettings, annotation: AnnotationInputs
) -> DefaultsDecision:
    """The record with the ADM-02 cost, latency and per-language blocks; refuses one that leaves a language below baseline."""
    runs = load_run_inputs(index)
    annotated = annotate_blocks(
        record,
        runs,
        incumbent_name=INCUMBENT_CONFIG,
        adopted_name=adopted_config_name(record, runs, index),
        prices=annotation.prices,
        budgets=annotation.budgets,
        budgets_sha256=annotation.budgets_sha256,
        settings=settings,
    )
    below = languages_below_baseline(annotated.per_language or [])
    if below:
        raise RegressionError(
            f"{LANGUAGE_BELOW_BASELINE}: the adopted configuration leaves {', '.join(below)} below the incumbent; "
            "no record is written"
        )
    return annotated


def _fmt(value: float | None, digits: int = 4) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def _default_reason(name: str, outcome: StageBOutcome) -> str:
    verdict = next((verdict for verdict in outcome.decision.verdicts if verdict.switch == name), None)
    if verdict is not None:
        return f"ablation verdict {verdict.decision} ({verdict.reason})"
    skip = next((reason for switch, reason in outcome.skipped if switch == name), None)
    if skip is not None:
        return f"follows the stage-B winner {outcome.base.winner} (ablation skipped: {skip})"
    return f"follows the stage-B winner {outcome.base.winner}"


def render_markdown(outcome: StageBOutcome, plan: RegressionPlan, settings: RuleSettings) -> str:
    decision = outcome.decision
    lines = [
        f"# Release defaults decision{' (provisional: fixtures)' if decision.provisional else ''}",
        "",
        f"- Decided at: {decision.decided_at}",
        f"- Plan sha256: `{decision.plan_sha256}` (stage {plan.stage}, {plan.split} split, {len(plan.configs)} registered configs)",
        f"- Primary metric: `{decision.primary_metric}`",
        f"- Noise band: max({settings.k} x spread, {settings.floor}); min_gate_n {settings.min_gate_n}; Holm alpha {settings.alpha}",
        f"- Incumbent source: `{decision.incumbent_source.path}` sha256 `{decision.incumbent_source.sha256}`",
        (
            f"- Test-split uses: {len(decision.test_split_uses)} (budget {plan.test_split_budget}; "
            f"unregistered {sum(1 for use in decision.test_split_uses if not use.registered)})"
        ),
        (
            f"- Stage-B winner: `{outcome.base.winner}`; embedding profile `{decision.embedding_profile}`, reranker "
            f"`{decision.reranker}`, backend `{decision.backend}`"
        ),
        f"- Confirmatory run: {'held' if outcome.confirm_ok else 'failed'} ({outcome.confirm_reason})",
        "",
    ]
    if decision.provisional:
        lines += ["Fixture record: it proves the tooling only and never moves a shipped default (D-18).", ""]
    lines += ["## Combinations against the incumbent", "", "| config | decision | reason | delta | band |", "| --- | --- | --- | --- | --- |"]
    for combo in outcome.base.combos:
        lines.append(f"| {combo.config_name} | {'adopt' if combo.adopted else 'keep_incumbent'} | {combo.reason} | {_fmt(combo.delta)} | {_fmt(combo.band)} |")
    comparison = decision.backend_comparison
    lines += ["", f"## Backends (winner `{comparison.winner}`, {comparison.reason})", ""]
    lines += ["| backend | config | valid | delta | ci_low | ci_high | band | cost | operations |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for result in comparison.results:
        valid = "yes" if result.valid else f"no ({result.invalid_reason})"
        lines.append(
            f"| {result.backend} | {result.config_name} | {valid} | {_fmt(result.delta)} | {_fmt(result.ci_low)} | "
            f"{_fmt(result.ci_high)} | {_fmt(result.band)} | {result.cost_note} | {result.operational_note} |"
        )
    lines += ["", "## Switch ablations", "", "| switch | value | decision | reason | delta | ci_low | ci_high | band | p | p_holm | latency ok | injection ASR | too small to gate |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for verdict in decision.verdicts:
        lines.append(
            f"| {verdict.switch} | {verdict.value} | {verdict.decision} | {verdict.reason} | {_fmt(verdict.delta)} | "
            f"{_fmt(verdict.ci_low)} | {_fmt(verdict.ci_high)} | {_fmt(verdict.band)} | {_fmt(verdict.p_value)} | "
            f"{_fmt(verdict.p_holm)} | {'yes' if verdict.latency_ok else 'no'} | {_fmt(verdict.injection_asr)} | "
            f"{', '.join(verdict.too_small_slices) or '-'} |"
        )
    for switch, reason in outcome.skipped:
        lines.append(f"| {switch} | - | skipped | {reason} | | | | | | | | | |")
    too_small = sorted({name for verdict in decision.verdicts for name in verdict.too_small_slices})
    lines += ["", "## Slices too small to gate", "", f"Reported, never deciding (fewer than {settings.min_gate_n} items): {', '.join(too_small) or 'none'}", ""]
    lines += ["## Invalid backend runs", ""]
    lines += [f"- {name}: {reason}" for name, reason in outcome.invalid_runs] or ["- none"]
    lines += ["", "## Defaults", "", "| variable | incumbent | default | reason |", "| --- | --- | --- | --- |"]
    for name in sorted(decision.incumbent):
        lines.append(f"| {name} | {decision.incumbent[name]} | {decision.defaults.get(name, decision.incumbent[name])} | {_default_reason(name, outcome)} |")
    lines += ["", "## Config hashes", "", "| config | sha256 |", "| --- | --- |"]
    lines += [f"| {name} | `{sha}` |" for name, sha in decision.config_hashes.items()]
    lines += ["", "## Test-split uses", "", "| run | config | registered | reason | used at |", "| --- | --- | --- | --- | --- |"]
    lines += [f"| {use.run_id} | {use.config_name} | {'yes' if use.registered else 'no'} | {use.reason or '-'} | {use.used_at} |" for use in decision.test_split_uses]
    return "\n".join(lines) + "\n"


def _usd(amount: Any) -> str:
    return f"{amount.usd:.6f}" if amount.usd is not None else str(amount.reason)


def render_cost_section(decision: DefaultsDecision) -> str:
    """The ADM-02 numbers of the record, in the same order as the JSON blocks."""
    lines = [COST_SECTION, ""]
    cost, latency, languages = decision.cost, decision.latency, decision.per_language
    if cost is None or latency is None or languages is None:
        return "\n".join([*lines, "Not annotated.", ""])
    basis = cost.basis
    lines += [
        (
            f"Price table sha256 `{basis.price_table_sha256}`; basis {basis.kind}; document sample {basis.document_sample}; "
            f"query sample {basis.query_sample}. An amount without a price reads not_provided, one the run did not record "
            "not_measured (USD)."
        ),
        "",
        "### Cost per 1,000 documents ingested",
        "",
        "| embedding profile | backend | parse | embedding | enrichment | external store |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for row in cost.per_1000_documents:
        parts = row.documents
        assert parts is not None
        lines.append(
            f"| {row.embedding_profile} | {row.backend} | {_usd(parts.parse)} | {_usd(parts.embedding)} | "
            f"{_usd(parts.enrichment)} | {_usd(parts.external_store)} |"
        )
    lines += ["", "### Cost per 1,000 queries", "", "| config | query embedding | rerank | generation | external store |", "| --- | --- | --- | --- | --- |"]
    for row in cost.per_1000_queries:
        queries = row.queries
        assert queries is not None
        lines.append(
            f"| {row.config_name} | {_usd(queries.query_embedding)} | {_usd(queries.rerank)} | "
            f"{_usd(queries.generation)} | {_usd(queries.external_store)} |"
        )
    lines += [
        "",
        f"### Latency (budgets sha256 `{latency.budgets_sha256}`)",
        "",
        "| config | channel | stage | p50 ms | p95 ms | budget p50 | budget p95 | within budget | report only |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for entry in latency.entries:
        for value in entry.values:
            within = "n/a" if value.within_budget is None else ("yes" if value.within_budget else "no")
            lines.append(
                f"| {entry.config_name} | {entry.channel} | {value.stage} | {_fmt(value.p50_ms, 1)} | {_fmt(value.p95_ms, 1)} | "
                f"{_fmt(value.budget_p50_ms, 1)} | {_fmt(value.budget_p95_ms, 1)} | {within} | {'yes' if value.report_only else 'no'} |"
            )
    lines += [
        "",
        "### Per-language quality against the incumbent",
        "",
        "| language | metric | n | value | baseline | difference | band | below baseline | reason |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in languages:
        below = "n/a" if row.below_baseline is None else ("yes" if row.below_baseline else "no")
        lines.append(
            f"| {row.language} | {row.metric} | {row.n} | {_fmt(row.value)} | {_fmt(row.baseline)} | {_fmt(row.difference)} | "
            f"{_fmt(row.band)} | {below} | {row.reason or '-'} |"
        )
    return "\n".join(lines) + "\n"


def with_cost_section(markdown: str, decision: DefaultsDecision) -> str:
    head = markdown.split(f"\n{COST_SECTION}\n", 1)[0].rstrip("\n") + "\n"
    return f"{head}\n{render_cost_section(decision)}"


def markdown_path(decisions_dir: Path, decision: DefaultsDecision) -> Path:
    if decision.provisional == "fixtures":
        return decisions_dir / FIXTURE_MARKDOWN
    return decisions_dir / f"defaults-{decision.decided_at[:10]}.md"


# ---------------------------------------------------------------- production harness


@dataclass
class SubprocessHarness:
    """Runs one config through the eval harness (run-smoke, the `npm run test-rag` script) with --run-config."""

    base_url: str | None = None
    fixture_mode: str | None = None
    repo_root: Path = REPO_ROOT

    def __call__(self, config: RegressionRunConfig, *, split: str, golden: Sequence[Path], out_dir: Path) -> RunArtifacts:
        inputs = out_dir / "inputs"
        inputs.mkdir(parents=True, exist_ok=True)
        golden_path = golden_for_splits(list(golden), inputs / f"golden.{split}.jsonl", (split,))
        overrides = {key: value for key, value in config.overrides.items() if key in RETRIEVAL_OVERRIDE_KEYS}
        run_config = {"name": config.name, "env": {} if self.base_url else dict(config.env), "overrides": overrides or None}
        config_path = inputs / "run-config.json"
        config_path.write_text(json.dumps(run_config, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        argv = ["npx", "tsx", HARNESS_SCRIPT, "--run-config", str(config_path), "--golden", str(golden_path), "--no-gate", "--out", str(out_dir)]
        profile = config.overrides.get("embedding_profile")
        if profile and profile != LEGACY_PROFILE:
            argv.extend(["--embedding-profile", str(profile)])
        if self.base_url:
            argv.extend(["--base-url", self.base_url])
        else:
            argv.append("--no-answers")
        if self.fixture_mode:
            argv.extend(["--fixture-mode", self.fixture_mode])
        result = subprocess.run(argv, cwd=self.repo_root, capture_output=True, text=True, check=False, env=os.environ.copy())
        if result.returncode != 0:
            raise RegressionError(
                f"harness exited with {result.returncode} for {config.name}\n{_tail(result.stdout, TAIL_LINES)}", EXIT_HARNESS
            )
        return load_artifacts(out_dir)


def interactive_env_confirmer(stream_in=sys.stdin, stream_out=sys.stdout) -> Callable[[RegressionRunConfig], bool]:
    previous: dict[str, str] = {}

    def confirm(config: RegressionRunConfig) -> bool:
        nonlocal previous
        if config.env == previous:
            return True
        print(f"regression: deploy {config.name} with this environment, then press Enter (type 'no' to stop):", file=stream_out)
        for name in sorted(config.env):
            shown = "<set in the deployment>" if name.endswith(("_KEY", "_SECRET", "_TOKEN")) else config.env[name]
            print(f"  {name}={shown}", file=stream_out)
        answer = stream_in.readline().strip().lower()
        if answer in ("n", "no"):
            return False
        previous = dict(config.env)
        return True

    return confirm


# ---------------------------------------------------------------- CLI


def _settings_for(plan: RegressionPlan, noise_path: Path, budgets_path: Path) -> RuleSettings:
    noise = _validate(NoiseConfig, resolve_cli_path(noise_path))
    budgets = _validate(LatencyBudgets, resolve_cli_path(budgets_path))
    return RuleSettings.build(
        noise, budgets, gated_slice_prefixes=plan.gated_slice_prefixes, min_gate_n=plan.min_gate_n, alpha=plan.alpha
    )


def _annotation_inputs(args: argparse.Namespace) -> AnnotationInputs:
    try:
        raw = resolve_cli_path(args.budgets).read_bytes()
        return AnnotationInputs(
            prices=load_price_table(resolve_cli_path(args.price_table)),
            budgets=LatencyBudgets.model_validate_json(raw),
            budgets_sha256=hashlib.sha256(raw).hexdigest(),
        )
    except (OSError, PriceTableError, ValidationError) as exc:
        raise RegressionError(f"the price table or latency budgets are unreadable: {exc}") from exc


def _load_plan(path: Path) -> tuple[RegressionPlan, str]:
    plan = _validate(RegressionPlan, resolve_cli_path(path))
    return plan, plan.canonical_sha256()


def _load_notes(path: Path | None) -> dict[str, dict[str, str]]:
    if path is None:
        return {}
    payload = _read_json(resolve_cli_path(path))
    if not isinstance(payload, dict):
        raise RegressionError(f"{path} must map a backend to its cost_note and operational_note")
    return {str(key): {k: str(v) for k, v in value.items()} for key, value in payload.items() if isinstance(value, dict)}


def _default_runs_dir(plan_path: Path) -> Path:
    return REPO_ROOT / "eval" / "out" / "regression" / resolve_cli_path(plan_path).stem


def _csv(value: str | None, default: Sequence[str]) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()] if value else list(default)


def cmd_plan(args: argparse.Namespace, clock: Clock) -> int:
    incumbent = load_incumbent(resolve_cli_path(args.incumbent))
    common = {
        "judge": args.judge,
        "gated_slice_prefixes": _csv(args.gated_slice_prefixes, DEFAULT_GATED_PREFIXES),
        "min_gate_n": args.min_gate_n,
        "alpha": args.alpha,
        "clock": clock,
    }
    if args.stage == "a":
        if args.split != "dev":
            raise RegressionError("stage A runs on the dev split")
        plan = plan_stage_a(
            incumbent,
            profiles=_csv(args.profiles, FIXTURE_PROFILES if args.fixtures else DEFAULT_PROFILES),
            rerankers=_csv(args.rerankers, FIXTURE_RERANKERS if args.fixtures else DEFAULT_RERANKERS),
            fixtures=args.fixtures,
            **common,
        )
    else:
        if args.split != "test":
            raise RegressionError("stage B runs on the locked test split")
        if args.stage_a_decision is None:
            raise RegressionError("stage B needs --stage-a-decision (the stage-A decide output)")
        stage_a = _validate(StageADecision, resolve_cli_path(args.stage_a_decision))
        plan = plan_stage_b(incumbent, stage_a, **common)
    out = resolve_cli_path(args.out)
    _write_text(out, plan.model_dump_json(indent=2) + "\n")
    print(f"regression: plan stage {plan.stage} ({len(plan.configs)} configs, test-split budget {plan.test_split_budget}) sha256 {plan.canonical_sha256()} -> {repo_relative(out)}")
    return EXIT_OK


def cmd_run(args: argparse.Namespace, clock: Clock, runner: HarnessRunner | None) -> int:
    plan, plan_sha = _load_plan(args.plan)
    if args.reason is not None and len(args.reason) < 10:
        raise RegressionError("--reason needs at least 10 characters")
    if args.base_url and not args.interactive_env and not args.fixtures:
        raise RegressionError("a live run applies each config's env by redeploying; pass --interactive-env to confirm each one")
    golden = [resolve_cli_path(path) for path in args.golden] if args.golden else ([FIXTURE_GOLDEN] if args.fixtures else [])
    if not golden:
        raise RegressionError("a live run names its golden set with --golden")
    extra = [_validate(RegressionRunConfig, resolve_cli_path(path)) for path in args.extra_config]
    ctx = RunContext(
        plan=plan,
        plan_sha=plan_sha,
        runs_dir=resolve_cli_path(args.runs_dir) if args.runs_dir else _default_runs_dir(args.plan),
        runner=runner or SubprocessHarness(base_url=args.base_url, fixture_mode=args.fixture_mode),
        golden=golden,
        golden_set="fixtures" if args.fixtures else "private",
        ledger=resolve_cli_path(args.ledger),
        settings=_settings_for(plan, args.noise, args.budgets),
        incumbent_env=load_incumbent(resolve_cli_path(args.incumbent)).env,
        notes=_load_notes(args.backend_notes),
        fixtures=args.fixtures,
        clock=clock,
        reason=args.reason,
        confirm_env=interactive_env_confirmer() if args.interactive_env else None,
    )
    run_plan(ctx, rerun=args.rerun, extra=extra)
    uses = [line for line in read_ledger(ctx.ledger) if line.plan_sha256 == plan_sha]
    print(f"regression: {len(ctx.summaries)} config(s) available; test-split uses under this plan: {len(uses)}")
    return EXIT_OK


def cmd_decide(args: argparse.Namespace, clock: Clock) -> int:
    plan, plan_sha = _load_plan(args.plan)
    runs_dir = resolve_cli_path(args.runs_dir) if args.runs_dir else _default_runs_dir(args.plan)
    index = read_index(runs_dir, plan_sha)
    settings = _settings_for(plan, args.noise, args.budgets)
    if plan.stage == "a":
        decision = decide_stage_a(plan, plan_sha, index, settings, clock)
        out = resolve_cli_path(args.out) if args.out else resolve_cli_path(args.plan).with_suffix(STAGE_A_SUFFIX)
        _write_text(out, decision.model_dump_json(indent=2) + "\n")
        print(f"regression: stage A top {[config.name for config in decision.top]} -> {repo_relative(out)}")
        return EXIT_OK
    incumbent = load_incumbent(resolve_cli_path(args.incumbent))
    try:
        outcome = decide_stage_b(
            plan,
            plan_sha,
            index,
            settings,
            incumbent,
            read_ledger(resolve_cli_path(args.ledger)),
            _load_notes(args.backend_notes),
            fixtures=args.fixtures,
            clock=clock,
            annotation=_annotation_inputs(args),
        )
    except ValidationError as exc:
        raise RegressionError(
            f"the defaults decision does not validate: {exc} (a live record also needs the cost, latency and per-language blocks)"
        ) from exc
    record = resolve_cli_path(args.out) if args.out else RECORD_PATH
    markdown = markdown_path(resolve_cli_path(args.decisions_dir), outcome.decision)
    DefaultsDecision.model_validate_json(outcome.decision.model_dump_json())
    _write_text(record, outcome.decision.model_dump_json(indent=2) + "\n")
    _write_text(markdown, with_cost_section(render_markdown(outcome, plan, settings), outcome.decision))
    print(f"regression: defaults decision -> {repo_relative(record)}, record -> {repo_relative(markdown)}")
    return EXIT_OK


def _canonical(decision: DefaultsDecision) -> str:
    return json.dumps(decision.model_dump(mode="json"), sort_keys=True)


def cmd_annotate(args: argparse.Namespace) -> int:
    """Recompute the ADM-02 blocks of an existing stage-B record from its run outputs; --check compares and writes nothing."""
    plan, plan_sha = _load_plan(args.plan)
    if plan.stage != "b":
        raise RegressionError("annotate reads a stage-B plan")
    record_path = resolve_cli_path(args.record)
    current = _validate(DefaultsDecision, record_path)
    if current.plan_sha256 != plan_sha:
        raise RegressionError(f"{repo_relative(record_path)} was decided under another plan ({current.plan_sha256[:12]})")
    runs_dir = resolve_cli_path(args.runs_dir) if args.runs_dir else _default_runs_dir(args.plan)
    index = read_index(runs_dir, plan_sha)
    if not index.entries:
        raise RegressionError(f"no run outputs for this plan in {repo_relative(runs_dir)}; annotate needs the stage-B runs")
    settings = _settings_for(plan, args.noise, args.budgets)
    annotated = annotate_decision(current, index, settings, _annotation_inputs(args))
    markdown = markdown_path(resolve_cli_path(args.decisions_dir), annotated)
    existing_md = markdown.read_text(encoding="utf-8") if markdown.is_file() else ""
    new_md = with_cost_section(existing_md, annotated)
    if args.check:
        if _canonical(annotated) != _canonical(current) or new_md != existing_md:
            print(f"regression: {repo_relative(record_path)} or {repo_relative(markdown)} differs from the recomputed blocks", file=sys.stderr)
            return EXIT_DIFFERS
        print("regression: the record's cost, latency and per-language blocks are current")
        return EXIT_OK
    _write_text(record_path, annotated.model_dump_json(indent=2) + "\n")
    _write_text(markdown, new_md)
    print(f"regression: annotated {repo_relative(record_path)} and {repo_relative(markdown)}")
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rag_eval.regression", description="myRAG release regression (D-17, D-18, A-10)")
    sub = parser.add_subparsers(dest="command", required=True)

    def shared(cmd: argparse.ArgumentParser) -> None:
        cmd.add_argument("--fixtures", action="store_true", help="fixture golden set; decide writes a provisional record")
        cmd.add_argument("--incumbent", type=Path, default=INCUMBENT_PATH)
        cmd.add_argument("--noise", type=Path, default=NOISE_PATH)
        cmd.add_argument("--budgets", type=Path, default=BUDGETS_PATH)
        cmd.add_argument("--ledger", type=Path, default=LEDGER_PATH)
        cmd.add_argument("--backend-notes", type=Path, help="JSON {backend: {cost_note, operational_note}}")
        cmd.add_argument("--price-table", type=Path, default=PRICE_TABLE_PATH)

    plan = sub.add_parser("plan", help="write a pre-registered RegressionPlan")
    shared(plan)
    plan.add_argument("--stage", choices=["a", "b"], required=True)
    plan.add_argument("--split", choices=["dev", "test"], required=True)
    plan.add_argument("--out", type=Path, required=True)
    plan.add_argument("--stage-a-decision", type=Path)
    plan.add_argument("--profiles", help="comma-separated embedding profiles (stage A)")
    plan.add_argument("--rerankers", help="comma-separated provider[:model] rerankers (stage A)")
    plan.add_argument("--judge", action="store_true", help="primary metric: judge answer correctness")
    plan.add_argument("--gated-slice-prefixes")
    plan.add_argument("--min-gate-n", type=int, default=DEFAULT_MIN_GATE_N)
    plan.add_argument("--alpha", type=float, default=DEFAULT_ALPHA)

    run = sub.add_parser("run", help="execute the registered configs through the eval harness")
    shared(run)
    run.add_argument("--plan", type=Path, required=True)
    run.add_argument("--runs-dir", type=Path)
    run.add_argument("--golden", type=Path, action="append")
    run.add_argument("--base-url")
    run.add_argument("--fixture-mode", choices=["prechunked", "ingest"])
    run.add_argument("--interactive-env", action="store_true", help="print each config's env and wait for the redeploy")
    run.add_argument("--rerun", action="append", default=[], help="run a registered config again (test split: needs --reason)")
    run.add_argument("--extra-config", type=Path, action="append", default=[], help="an unregistered RegressionRunConfig")
    run.add_argument("--reason", help="why a test-split run outside the plan is needed (recorded in the ledger)")

    decide = sub.add_parser("decide", help="apply the decision rule and write the records")
    shared(decide)
    decide.add_argument("--plan", type=Path, required=True)
    decide.add_argument("--runs-dir", type=Path)
    decide.add_argument("--out", type=Path, help="stage A: decision JSON; stage B: the defaults record")
    decide.add_argument("--decisions-dir", type=Path, default=DECISIONS_DIR)

    annotate = sub.add_parser("annotate", help="write the ADM-02 cost, latency and per-language blocks into a record")
    shared(annotate)
    annotate.add_argument("--record", type=Path, default=RECORD_PATH)
    annotate.add_argument("--plan", type=Path, required=True)
    annotate.add_argument("--runs-dir", type=Path)
    annotate.add_argument("--decisions-dir", type=Path, default=DECISIONS_DIR)
    annotate.add_argument("--check", action="store_true", help="exit 1 when the record on disk differs; write nothing")
    return parser


def main(argv: list[str] | None = None, *, clock: Clock = utc_now, runner: HarnessRunner | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "plan":
            return cmd_plan(args, clock)
        if args.command == "run":
            return cmd_run(args, clock, runner)
        if args.command == "annotate":
            return cmd_annotate(args)
        return cmd_decide(args, clock)
    except RegressionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.code
    except ValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE


if __name__ == "__main__":
    raise SystemExit(main())
