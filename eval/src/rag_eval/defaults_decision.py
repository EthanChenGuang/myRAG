"""Phase 4.1 retrieval-defaults decision record (CONTEXT D-13 to D-15, D-25, D-26).

Built mechanically from the defaults gate result (plan 04.1-07) and the capped live rerank result (plan 04.1-08). Every number
in the record is copied from those files, which are named with their sha256; `check-current` tells a later plan whether the
baselines, criteria, gate and live files the decision was taken on are still the files in force. The record names no RAG mode:
refusal is the single-threshold behaviour (D-26)."""

import argparse
import re
import sys
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from rag_eval.defaults_gate import (
    CheckResult,
    ConfigResult,
    CriterionId,
    DefaultsGateResult,
    FallbackName,
    FloorName,
    G8Result,
    Mode,
    sha256_file,
)
from rag_eval.live_rerank_probe import LiveRerankResult, SplitQuality
from rag_eval.paths import repo_relative, resolve_cli_path

EXIT_CURRENT = 0
EXIT_STALE = 1
EXIT_INVALID = 2
EXIT_INTERNAL = 70

Profile = Literal["chat", "embed", "eval", "voice"]
PROFILES: tuple[Profile, ...] = ("chat", "embed", "eval", "voice")
CHAT_TIER_PROFILES: tuple[Profile, ...] = ("chat", "embed", "eval")
DEFAULT_VARIABLES = ("RAG_PIPELINE", "RAG_LEXICAL_SEARCH", "RAG_RERANKER", "RAG_REFUSAL_THRESHOLD", "RAG_REFUSAL_FLOOR")
D01_VALUES = {
    "RAG_PIPELINE": "v2",
    "RAG_LEXICAL_SEARCH": "true",
    "RAG_RERANKER": "auto",
    "RAG_REFUSAL_THRESHOLD": "true",
    "RAG_REFUSAL_FLOOR": "legacy_rule",
}
IMPLICIT_IN_TEMPLATES = ["RAG_PIPELINE"]
HOSTED_PREFERENCE = "cohere"
AUTO_CHAT_MODEL = "live-cohere-pro"
AUTO_VOICE_MODEL = "live-cohere-fast"
CRITERION_ORDER: tuple[CriterionId, ...] = ("G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8")
SECRET_NAME = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)", re.IGNORECASE)
FLOAT_TOLERANCE = 1e-12
NOTES_MARKER = "<!-- Generated above this line by `python -m rag_eval.defaults_decision build`; hand-written notes below are kept. -->"

CAVEAT = (
    "Provisional: every golden item is synthetic fixture data, retrieved with the lexical fixture embedder (research R-4). "
    "When the real dev split first reaches the live calibration minimums, G1 to G4 run again on it (D-14)."
)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class FileRef(_Model):
    path: str = Field(min_length=1)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class Baselines(_Model):
    prechunked: FileRef
    ingest: FileRef


class RunRecord(_Model):
    config: str
    mode: Mode
    role: Literal["required", "candidate", "legacy"]
    run_id: str
    run_config_hash: str
    report_path: str
    report_sha256: str
    passed: bool


class CriterionRun(_Model):
    config: str
    mode: Mode
    run_id: str
    status: Literal["pass", "fail", "skipped"]
    checks: list[CheckResult]
    notes: list[str] = Field(default_factory=list)


class CriterionRecord(_Model):
    id: CriterionId
    status: Literal["pass", "fail", "skipped", "not_run", "report_only"]
    results: list[CriterionRun] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class G7Model(_Model):
    name: str
    vendor: str
    model: str
    tier: str
    run_config: str
    run_id: str
    n: int
    recall_at_10: float | None
    mrr: float | None
    p95_ms: float | None


class G7Record(_Model):
    status: Literal["complete", "stopped", "pending_live"]
    live_result: FileRef
    cap: int
    total_requests: int
    band: dict[str, float]
    latency_budgets_ms: dict[str, float]
    models: list[G7Model]
    offline_references: dict[str, SplitQuality]
    verdicts: dict[str, str]


class DroppedProfile(_Model):
    profile: Profile
    reason: str


class HostedDecision(_Model):
    preference: Literal["cohere"]
    basis: Literal["live", "pending_live", "stopped"]
    dropped: list[DroppedProfile]
    notes: list[str] = Field(default_factory=list)


class DecisionRecord(_Model):
    """The retrieval-defaults decision Phase 7 takes as its incumbent (D-15). No field names a RAG mode (D-26)."""

    schema_version: Literal[1] = 1
    phase: Literal["04.1"] = "04.1"
    provisional: Literal[True]
    status: Literal["flip", "not_flipped"]
    reasons: list[str]
    refusal_basis: Literal["single_threshold"]
    defaults: dict[str, str]
    refusal_floor: FloorName | None
    auto_no_key_fallback: FallbackName | None
    auto_hosted_profiles: list[Profile]
    hosted: HostedDecision
    implicit_in_templates: list[str]
    criteria_file: FileRef
    baselines: Baselines
    gate: FileRef
    gate_passed: bool
    gate_failures: list[str]
    open_blockers: list[str]
    runs: list[RunRecord]
    criteria: list[CriterionRecord]
    g7: G7Record
    g8: G8Result
    caveat: str

    @model_validator(mode="after")
    def _consistent(self) -> "DecisionRecord":
        secret = sorted(name for name in self.defaults if SECRET_NAME.search(name))
        if secret:
            raise ValueError(f"the defaults map may not hold a key-typed variable: {', '.join(secret)}")
        if sorted(self.defaults) != sorted(DEFAULT_VARIABLES):
            raise ValueError(f"defaults must hold exactly {', '.join(DEFAULT_VARIABLES)}")
        if self.implicit_in_templates != IMPLICIT_IN_TEMPLATES:
            raise ValueError("implicit_in_templates must be exactly ['RAG_PIPELINE'] (D-25)")
        if [p for p in PROFILES if p in self.auto_hosted_profiles] != self.auto_hosted_profiles:
            raise ValueError("auto_hosted_profiles must be distinct and in profile order")
        if self.refusal_floor is not None and self.defaults["RAG_REFUSAL_FLOOR"] != self.refusal_floor:
            raise ValueError("defaults.RAG_REFUSAL_FLOOR must be the chosen refusal_floor")
        if self.status == "flip" and (self.reasons or self.refusal_floor is None or self.auto_no_key_fallback is None):
            raise ValueError("a flip needs a chosen floor and fallback and no reason against it")
        if self.status == "not_flipped" and not self.reasons:
            raise ValueError("not_flipped needs at least one reason")
        if [c.id for c in self.criteria] != list(CRITERION_ORDER):
            raise ValueError("criteria must list G1 to G8 in order")
        return self


# ---------- build


class StaleInputError(Exception):
    pass


def _ref(path: str | Path) -> FileRef:
    resolved = resolve_cli_path(path)
    return FileRef(path=repo_relative(resolved), sha256=sha256_file(resolved))


def _recorded_ref(path: str, recorded_sha256: str, what: str) -> FileRef:
    ref = _ref(path)
    if ref.sha256 != recorded_sha256:
        raise StaleInputError(f"{what} {ref.path} is not the file the gate evaluated (sha256 {ref.sha256} != {recorded_sha256})")
    return ref


def _hosted(live: LiveRerankResult) -> tuple[list[Profile], HostedDecision]:
    if live.status == "pending_live":
        return list(PROFILES), HostedDecision(
            preference=HOSTED_PREFERENCE,
            basis="pending_live",
            dropped=[],
            notes=[
                (
                    "G7 not run: the live passes of plan 04.1-08 are an operator action; AUTO_HOSTED_PROFILES keeps its code "
                    "default until this record is rebuilt from a complete live result"
                )
            ],
        )
    if live.status == "stopped":
        reason = f"the live run stopped ({live.stop_reason or 'no reason recorded'}): hosted rerank is not shown to work"
        return [], HostedDecision(
            preference=HOSTED_PREFERENCE, basis="stopped", dropped=[DroppedProfile(profile=p, reason=reason) for p in PROFILES]
        )

    models = {model.name: model for model in live.models}
    dropped: list[DroppedProfile] = []

    chat_reasons: list[str] = []
    chat = models.get(AUTO_CHAT_MODEL)
    chat_budget = live.latency_budgets_ms["chat"]
    if chat is None:
        chat_reasons.append(f"no live result for {AUTO_CHAT_MODEL}")
    else:
        if chat.p95_ms is None:
            chat_reasons.append(f"{AUTO_CHAT_MODEL}: no successful probe request")
        elif chat.p95_ms > chat_budget:
            chat_reasons.append(f"{AUTO_CHAT_MODEL}: p95 {chat.p95_ms:.1f} ms > {chat_budget:.0f} ms")
        for ref_name in ("local_bm25", "none"):
            reference = live.offline_references.get(ref_name)
            if reference is None:
                chat_reasons.append(f"{AUTO_CHAT_MODEL}: no {ref_name} reference")
                continue
            for label, metric in (("Recall@10", "recall_at_10"), ("MRR", "mrr")):
                value, ref_value, band = getattr(chat, metric), getattr(reference, metric), live.band[metric]
                if value is None or ref_value is None:
                    chat_reasons.append(f"{AUTO_CHAT_MODEL}: {label} missing for the {ref_name} comparison")
                elif value < ref_value - band - FLOAT_TOLERANCE:
                    chat_reasons.append(
                        f"{AUTO_CHAT_MODEL}: {label} {value:.4f} < {ref_name} {ref_value:.4f} - band {band:.4f} "
                        f"(n {chat.n} vs {reference.n})"
                    )
    if chat_reasons:
        dropped += [DroppedProfile(profile=p, reason="; ".join(chat_reasons)) for p in CHAT_TIER_PROFILES]

    voice = models.get(AUTO_VOICE_MODEL)
    voice_budget = live.latency_budgets_ms["voice"]
    voice_reason: str | None = None
    if voice is None:
        voice_reason = f"no live result for {AUTO_VOICE_MODEL}"
    elif voice.p95_ms is None:
        voice_reason = f"{AUTO_VOICE_MODEL}: no successful probe request"
    elif voice.p95_ms > voice_budget:
        voice_reason = f"{AUTO_VOICE_MODEL}: p95 {voice.p95_ms:.1f} ms > {voice_budget:.0f} ms (D-09)"
    if voice_reason:
        dropped.append(DroppedProfile(profile="voice", reason=voice_reason))

    gone = {d.profile for d in dropped}
    return [p for p in PROFILES if p not in gone], HostedDecision(preference=HOSTED_PREFERENCE, basis="live", dropped=dropped)


def _g7(live: LiveRerankResult, live_ref: FileRef) -> G7Record:
    return G7Record(
        status=live.status,
        live_result=live_ref,
        cap=live.cap,
        total_requests=live.total_requests,
        band=dict(live.band),
        latency_budgets_ms=dict(live.latency_budgets_ms),
        models=[
            G7Model(
                name=m.name, vendor=m.vendor, model=m.model, tier=m.tier, run_config=m.run_config, run_id=m.run_id,
                n=m.n, recall_at_10=m.recall_at_10, mrr=m.mrr, p95_ms=m.p95_ms,
            )
            for m in live.models
        ],
        offline_references=dict(live.offline_references),
        verdicts=dict(live.g7),
    )


def _criteria_records(gate: DefaultsGateResult, g7: G7Record) -> list[CriterionRecord]:
    runs_by_id: dict[str, list[CriterionRun]] = {gid: [] for gid in CRITERION_ORDER}
    for config in gate.configurations:
        for mode in config.modes:
            for criterion in mode.criteria:
                runs_by_id[criterion.id].append(
                    CriterionRun(
                        config=config.name, mode=mode.mode, run_id=mode.run_id, status=criterion.status,
                        checks=criterion.checks, notes=criterion.notes,
                    )
                )
    records: list[CriterionRecord] = []
    for gid in CRITERION_ORDER:
        if gid == "G7":
            status = "not_run" if g7.status == "pending_live" else "report_only"
            records.append(CriterionRecord(id=gid, status=status, notes=[f"{k}: {v}" for k, v in sorted(g7.verdicts.items())]))
            continue
        if gid == "G8":
            records.append(CriterionRecord(id=gid, status=gate.g8.status, notes=list(gate.g8.notes)))
            continue
        results = runs_by_id[gid]
        statuses = {r.status for r in results}
        status = "fail" if "fail" in statuses else ("pass" if results and statuses == {"pass"} else "skipped")
        records.append(CriterionRecord(id=gid, status=status, results=results))
    return records


def _flip_reasons(gate: DefaultsGateResult, blockers: list[str]) -> list[str]:
    reasons = list(gate.failures)
    found: dict[str, ConfigResult] = {config.name: config for config in gate.configurations}
    details = gate.selection_details
    for label, chosen, candidates, rule in (
        ("refusal floor", gate.selections.floor, details.floor.candidates, "D-04"),
        ("no-key fallback", gate.selections.no_key_fallback, details.no_key_fallback.candidates, "D-06"),
    ):
        if chosen is None:
            reasons.append(f"no {label} qualified ({rule})")
            continue
        candidate = next((c for c in candidates if c.name == chosen), None)
        if candidate is None:
            reasons.append(f"{label} {chosen}: the gate result lists no configurations for it")
            continue
        for name in candidate.configurations:
            if name not in found:
                reasons.append(f"{name} ({label} {chosen}) has no result")
            elif not found[name].passed:
                reasons.append(f"{name} ({label} {chosen}) failed")
    for config in gate.configurations:
        if config.role == "legacy" and not config.passed:
            reasons.append(f"{config.name} (G6) failed")
    if gate.g8.status != "pass":
        reasons.append(f"G8 {gate.g8.status}")
    if gate.g8.two_tenant_matrix is not None:
        for name, ok in gate.g8.two_tenant_matrix.model_dump().items():
            if not ok:
                reasons.append(f"G8: two-tenant matrix {name} did not pass")
    if gate.g8.negative_checks is not None:
        for name, ok in gate.g8.negative_checks.model_dump().items():
            if not ok:
                check = name.removesuffix("_fails")
                reasons.append(f"G8: negative check {check} did not fail as designed")
    if not gate.passed and not gate.failures:
        reasons.append("the gate did not pass")
    reasons += [f"open 04.1-05 blocker: {blocker}" for blocker in blockers]
    unique: list[str] = []
    for reason in reasons:
        if reason not in unique:
            unique.append(reason)
    return unique


def build_decision(gate_path: Path, live_path: Path, *, blockers: list[str] | None = None) -> DecisionRecord:
    gate_file = resolve_cli_path(gate_path)
    live_file = resolve_cli_path(live_path)
    gate = DefaultsGateResult.model_validate_json(gate_file.read_text(encoding="utf-8"))
    live = LiveRerankResult.model_validate_json(live_file.read_text(encoding="utf-8"))
    sources = {source.role: source for source in gate.sources}
    for mode in ("prechunked", "ingest"):
        if f"baseline:{mode}" not in sources:
            raise StaleInputError(f"the gate result names no baseline:{mode} source")
    baselines = Baselines(
        prechunked=_recorded_ref(sources["baseline:prechunked"].path, sources["baseline:prechunked"].sha256, "baseline"),
        ingest=_recorded_ref(sources["baseline:ingest"].path, sources["baseline:ingest"].sha256, "baseline"),
    )
    criteria_file = _recorded_ref(gate.criteria_path, gate.criteria_sha256, "criteria file")
    gate_ref, live_ref = _ref(gate_file), _ref(live_file)

    open_blockers = list(blockers or [])
    reasons = _flip_reasons(gate, open_blockers)
    floor, fallback = gate.selections.floor, gate.selections.no_key_fallback
    auto_hosted, hosted = _hosted(live)
    g7 = _g7(live, live_ref)
    defaults = dict(D01_VALUES)
    if floor is not None:
        defaults["RAG_REFUSAL_FLOOR"] = floor
    runs = [
        RunRecord(
            config=config.name, mode=mode.mode, role=config.role, run_id=mode.run_id, run_config_hash=mode.run_config_hash,
            report_path=mode.report_path, report_sha256=mode.report_sha256, passed=mode.passed,
        )
        for config in gate.configurations
        for mode in config.modes
    ]
    return DecisionRecord(
        provisional=True,
        status="not_flipped" if reasons else "flip",
        reasons=reasons,
        refusal_basis=gate.refusal_basis,
        defaults=defaults,
        refusal_floor=floor,
        auto_no_key_fallback=fallback,
        auto_hosted_profiles=auto_hosted,
        hosted=hosted,
        implicit_in_templates=list(IMPLICIT_IN_TEMPLATES),
        criteria_file=criteria_file,
        baselines=baselines,
        gate=gate_ref,
        gate_passed=gate.passed,
        gate_failures=list(gate.failures),
        open_blockers=open_blockers,
        runs=runs,
        criteria=_criteria_records(gate, g7),
        g7=g7,
        g8=gate.g8,
        caveat=CAVEAT,
    )


# ---------- Markdown


def _fmt(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.4f}"


def render_markdown(record: DecisionRecord) -> str:
    lines = ["# Phase 4.1 retrieval-defaults decision", ""]
    lines.append(f"Status: **{record.status}** (provisional: fixture evidence only, until the real-golden re-run of D-14)")
    lines.append(f"Refusal basis: {record.refusal_basis}")
    lines.append("")
    if record.reasons:
        lines += ["## Why not flipped", "", *[f"- {reason}" for reason in record.reasons], ""]
        failing = [
            f"- {criterion.id} {result.config} ({result.mode}): {check.name} {check.slice or ''} {check.metric or ''} "
            f"observed {_fmt(check.observed)} (n {'' if check.n is None else check.n}) bound {_fmt(check.bound)}"
            for criterion in record.criteria
            for result in criterion.results
            for check in result.checks
            if check.status == "fail"
        ]
        if failing:
            lines += ["### Failing slices and criteria", "", *failing, ""]
    lines += ["## Values", "", "| Variable | Value |", "| --- | --- |"]
    lines += [f"| {name} | {record.defaults[name]} |" for name in DEFAULT_VARIABLES]
    lines += [
        "",
        f"- refusal floor (D-04): {record.refusal_floor or 'none chosen'}",
        f"- no-key fallback, AUTO_NO_KEY_FALLBACK (D-06): {record.auto_no_key_fallback or 'none chosen'}",
        (
            f"- AUTO_HOSTED_PROFILES (D-09, G7): {', '.join(record.auto_hosted_profiles) or '(none)'}; hosted preference "
            f"{record.hosted.preference}; basis {record.hosted.basis}"
        ),
        *[f"  - {d.profile} dropped: {d.reason}" for d in record.hosted.dropped],
        *[f"  - {note}" for note in record.hosted.notes],
        f"- implicit in templates (D-25): {', '.join(record.implicit_in_templates)}",
        "",
        "## Files the decision was taken on",
        "",
        "| Role | Path | sha256 |",
        "| --- | --- | --- |",
        f"| criteria | {record.criteria_file.path} | {record.criteria_file.sha256} |",
        f"| baseline prechunked | {record.baselines.prechunked.path} | {record.baselines.prechunked.sha256} |",
        f"| baseline ingest | {record.baselines.ingest.path} | {record.baselines.ingest.sha256} |",
        f"| gate result | {record.gate.path} | {record.gate.sha256} |",
        f"| live result | {record.g7.live_result.path} | {record.g7.live_result.sha256} |",
        "",
        "`python -m rag_eval.defaults_decision check-current --decision <this record>.json` exits 0 only while these files are unchanged.",
        "",
        "## Runs",
        "",
        "| Configuration | Role | Mode | Run id | run_config_hash | Passed |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    lines += [f"| {r.config} | {r.role} | {r.mode} | {r.run_id} | {r.run_config_hash} | {r.passed} |" for r in record.runs]
    lines += ["", "## Criteria", ""]
    for criterion in record.criteria:
        lines += [f"### {criterion.id}: {criterion.status}", ""]
        if criterion.results:
            lines += [
                "| Configuration | Mode | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |",
                "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
            ]
            for result in criterion.results:
                for check in result.checks:
                    lines.append(
                        f"| {result.config} | {result.mode} | {check.name} | {check.slice or ''} | {check.metric or ''} | "
                        f"{_fmt(check.observed)} | {'' if check.n is None else check.n} | {_fmt(check.bound)} | "
                        f"{_fmt(check.baseline_mean)} | {_fmt(check.band)} | {_fmt(check.upper_95)} | "
                        f"{check.status}{' (' + check.reason + ')' if check.reason else ''} |"
                    )
            lines.append("")
        if criterion.id == "G7":
            lines.append(f"Live result status {record.g7.status}, {record.g7.total_requests} of {record.g7.cap} requests.")
            lines.append("")
            lines += ["| Reference | Run config | Run id | n | Recall@10 | MRR |", "| --- | --- | --- | --- | --- | --- |"]
            lines += [
                f"| {name} | {ref.run_config} | {ref.run_id} | {ref.n} | {_fmt(ref.recall_at_10)} | {_fmt(ref.mrr)} |"
                for name, ref in sorted(record.g7.offline_references.items())
            ]
            lines.append("")
            if record.g7.models:
                lines += ["| Model | Tier | Run id | n | Recall@10 | MRR | p95 ms |", "| --- | --- | --- | --- | --- | --- | --- |"]
                lines += [
                    f"| {m.vendor} {m.model} | {m.tier} | {m.run_id} | {m.n} | {_fmt(m.recall_at_10)} | {_fmt(m.mrr)} | "
                    f"{'n/a' if m.p95_ms is None else f'{m.p95_ms:.1f}'} |"
                    for m in record.g7.models
                ]
                lines.append("")
        if criterion.id == "G8":
            if record.g8.two_tenant_matrix:
                lines.append(
                    f"- two-tenant matrix under the D-01 values: single-tenant {record.g8.two_tenant_matrix.single_tenant}, "
                    f"multi-tenant {record.g8.two_tenant_matrix.multi_tenant}"
                )
            if record.g8.negative_checks:
                lines.append(
                    f"- negative checks fail as designed: drop_top_candidate {record.g8.negative_checks.drop_top_candidate_fails}, "
                    f"max_results 1 {record.g8.negative_checks.max_results_1_fails}"
                )
            lines.append("")
        lines += [f"- {note}" for note in criterion.notes]
        if criterion.notes:
            lines.append("")
    lines += ["## Caveat", "", record.caveat, "", NOTES_MARKER, ""]
    return "\n".join(lines)


# ---------- CLI


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _kept_notes(path: Path) -> str:
    if not path.is_file():
        return ""
    text = path.read_text(encoding="utf-8")
    index = text.find(NOTES_MARKER)
    return "" if index < 0 else text[index + len(NOTES_MARKER) + 1 :]


def _cmd_build(args: argparse.Namespace) -> int:
    record = build_decision(args.gate, args.live, blockers=args.blocker)
    out = resolve_cli_path(args.out)
    json_path, md_path = out.with_name(out.name + ".json"), out.with_name(out.name + ".md")
    markdown = render_markdown(record) + _kept_notes(md_path)
    _write_text(json_path, record.model_dump_json(indent=2) + "\n")
    _write_text(md_path, markdown)
    print(f"defaults_decision: {record.status} (floor {record.refusal_floor}, no-key fallback {record.auto_no_key_fallback})")
    return EXIT_CURRENT


def _cmd_check(args: argparse.Namespace) -> int:
    path = resolve_cli_path(args.decision)
    record = DecisionRecord.model_validate_json(path.read_text(encoding="utf-8"))
    stale: list[str] = []
    for role, ref in (
        ("criteria", record.criteria_file),
        ("baseline:prechunked", record.baselines.prechunked),
        ("baseline:ingest", record.baselines.ingest),
        ("gate", record.gate),
        ("live", record.g7.live_result),
    ):
        target = resolve_cli_path(ref.path)
        if not target.is_file():
            stale.append(f"{role} {ref.path} is missing")
        elif sha256_file(target) != ref.sha256:
            stale.append(f"{role} {ref.path} differs from the file the decision was taken on")
    if stale:
        print("defaults_decision: stale", file=sys.stderr)
        for line in stale:
            print(f"  {line}", file=sys.stderr)
        return EXIT_STALE
    print(f"defaults_decision: current ({record.status})")
    return EXIT_CURRENT


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.defaults_decision", description="Phase 4.1 retrieval-defaults decision record")
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--gate", required=True, type=Path)
    build.add_argument("--live", required=True, type=Path)
    build.add_argument("--out", required=True, type=Path, help="output path without extension; writes <out>.json and <out>.md")
    build.add_argument("--blocker", action="append", default=[], help="an open 04.1-05 blocker (repeatable); any blocker means not_flipped")
    check = commands.add_parser("check-current")
    check.add_argument("--decision", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            return _cmd_build(args)
        return _cmd_check(args)
    except StaleInputError as exc:
        print(f"defaults_decision: stale input: {exc}", file=sys.stderr)
        return EXIT_STALE
    except (OSError, ValidationError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID


def main(argv: list[str] | None = None) -> int:
    try:
        return _main(argv)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - a crash must not look like a verdict
        print(f"defaults_decision: INTERNAL ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_INTERNAL


if __name__ == "__main__":
    raise SystemExit(main())
