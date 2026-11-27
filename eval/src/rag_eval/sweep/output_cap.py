"""D-34 (LAT-05): the output-cap sweep, the only writer of eval/config/output-caps.json."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable, Literal, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.output_guard import OutputCapCell, OutputCaps

from rag_eval.config_files import write_config_atomically
from rag_eval.golden_io import golden_sha256, load_golden
from rag_eval.harness_runner import HarnessError, HarnessRun, run_harness
from rag_eval.paths import REPO_ROOT, repo_relative, resolve_cli_path
from rag_eval.split import assign_split
from rag_eval.sweep.retrieval import noise_band

Mode = Literal["strict", "balanced"]

DEFAULT_CANDIDATES: tuple[int, ...] = (512, 768, 1024, 1536, 2048)
DEFAULT_MODES: tuple[Mode, ...] = ("strict", "balanced")
# The app treats a cap below this floor as off (MIN_OUTPUT_TOKENS_FLOOR in src/lib/rag/generation/answer-config.ts).
MIN_CANDIDATE = 256
# D-34: a cap qualifies only while fewer than 2% of its answers stop at the cap (finishReason length).
TRUNCATION_RATE_LIMIT = 0.02
UNCAPPED = "off"
CAPS_PATH = REPO_ROOT / "eval" / "config" / "output-caps.json"
NOISE_PATH = REPO_ROOT / "eval" / "config" / "noise.json"
DEFAULT_GOLDEN = REPO_ROOT / "eval" / "fixtures" / "golden.jsonl"
DEFAULT_RUN_CONFIG = REPO_ROOT / "eval" / "config" / "runs" / "p52-output-cap.json"
DEFAULT_REPORT_DIR = REPO_ROOT / "eval" / "out" / "sweep-output-cap"
RESULT_NAME = "output-cap-sweep.json"
REPORT_NAME = "output-cap-sweep.md"
GENERATION_STAGE = "generation"
LENGTH_FINISH = "length"
EPSILON = 1e-9

SELECTION_RULE = (
    "Per mode, the smallest candidate cap whose answer correctness and citation recall are both within the noise band of the "
    "uncapped run and whose truncation rate (finishReason length) is below 2%; with no qualifying cap the mode stays off."
)
TOKEN_NOTE = "Output tokens are counted as whitespace-separated words of the final answer (the trace carries no usage)."

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_HARNESS = 3

_SPACE = re.compile(r"\s+")


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class OutputCapSweepError(Exception):
    pass


class CandidateResult(_Model):
    mode: Mode
    # None is the uncapped run.
    cap: int | None = Field(default=None, ge=MIN_CANDIDATE)
    answer_correctness: float = Field(ge=0, le=1)
    citation_recall: float = Field(ge=0, le=1)
    mean_output_tokens: float = Field(ge=0)
    generation_latency_p95_ms: float = Field(ge=0)
    truncation_rate: float = Field(ge=0, le=1)
    n_answers: int = Field(ge=0)
    n_scored: int = Field(ge=0)
    run_id: str | None = None
    run_config_hash: str | None = None
    out_dir: str | None = None


class ModeSelection(_Model):
    mode: Mode
    limit: int | None
    noise_band: float
    qualifying: list[int] = Field(default_factory=list)
    reasons: dict[str, list[str]] = Field(default_factory=dict)
    run_ids: list[str] = Field(default_factory=list)
    config_hash: str | None = None


class OutputCapSweepResult(_Model):
    schema_version: int = 1
    mode: Literal["live", "fixture"]
    dev_only: bool = True
    rule: str = SELECTION_RULE
    token_note: str = TOKEN_NOTE
    truncation_rate_limit: float = TRUNCATION_RATE_LIMIT
    run_config_name: str = ""
    run_config_sha256: str = ""
    golden_sha256: str = ""
    candidates: list[int] = Field(default_factory=list)
    modes: list[Mode] = Field(default_factory=list)
    results: list[CandidateResult] = Field(default_factory=list)
    selections: list[ModeSelection] = Field(default_factory=list)
    caps: dict[str, Any] | None = None
    caps_written: bool = False
    caps_path: str | None = None
    notes: list[str] = Field(default_factory=list)


def validate_candidates(values: Sequence[int]) -> tuple[int, ...]:
    if not values:
        raise OutputCapSweepError("the candidate list must not be empty")
    low = [value for value in values if value < MIN_CANDIDATE]
    if low:
        raise OutputCapSweepError(f"candidate caps below the {MIN_CANDIDATE}-token floor are off in the app: {low}")
    return tuple(sorted(set(values)))


def select_cap(results: Sequence[CandidateResult], noise: NoiseConfig, mode: Mode, spread: float = 0.0) -> ModeSelection:
    """D-34: the smallest cap within the noise band of the uncapped run on correctness and citation recall, truncating < 2%."""
    own = [result for result in results if result.mode == mode]
    uncapped = [result for result in own if result.cap is None]
    if not uncapped:
        raise OutputCapSweepError(f"mode {mode}: the uncapped run is missing; no cap can be chosen without it")
    if len(uncapped) > 1:
        raise OutputCapSweepError(f"mode {mode}: more than one uncapped run")
    base = uncapped[0]
    band = noise_band(noise, spread)
    qualifying: list[int] = []
    reasons: dict[str, list[str]] = {}
    for result in sorted((r for r in own if r.cap is not None), key=lambda r: r.cap or 0):
        failed: list[str] = []
        if result.answer_correctness < base.answer_correctness - band - EPSILON:
            failed.append("answer_correctness_outside_band")
        if result.citation_recall < base.citation_recall - band - EPSILON:
            failed.append("citation_recall_outside_band")
        if not result.truncation_rate < TRUNCATION_RATE_LIMIT:
            failed.append("truncation_rate_at_or_above_limit")
        if failed:
            reasons[str(result.cap)] = failed
        else:
            qualifying.append(result.cap)  # type: ignore[arg-type]
    limit = qualifying[0] if qualifying else None
    chosen = next((r for r in own if r.cap == limit), None) if limit is not None else None
    run_ids = [run_id for run_id in (base.run_id, chosen.run_id if chosen else None) if run_id]
    config_hash = (chosen or base).run_config_hash
    return ModeSelection(
        mode=mode,
        limit=limit,
        noise_band=band,
        qualifying=qualifying,
        reasons=reasons,
        run_ids=run_ids,
        config_hash=config_hash,
    )


def _default_cell(mode: Mode) -> OutputCapCell:
    return OutputCapCell(mode=mode, limit=None, source="default")


def build_caps(selections: Sequence[ModeSelection], existing: OutputCaps | None = None) -> OutputCaps:
    """The caps file: a sweep cell for every swept mode (off when nothing qualified), the existing or default cell otherwise."""
    by_mode = {selection.mode: selection for selection in selections}
    previous = {cell.mode: cell for cell in (existing.cells if existing else [])}
    cells: list[OutputCapCell] = []
    for mode in DEFAULT_MODES:
        selection = by_mode.get(mode)
        if selection is None:
            cells.append(previous.get(mode) or _default_cell(mode))
            continue
        if not selection.run_ids or not selection.config_hash:
            raise OutputCapSweepError(f"mode {mode}: the runs carry no run id or config hash; nothing is written without evidence")
        cells.append(
            OutputCapCell(
                mode=mode,
                limit=selection.limit,
                source="sweep",
                run_ids=list(selection.run_ids),
                config_hash=selection.config_hash,
            )
        )
    return OutputCaps.model_validate(OutputCaps(cells=cells).model_dump(mode="json"))


def _normalize(text: str) -> str:
    return _SPACE.sub(" ", text).strip().casefold()


def _nearest_rank(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    return ordered[max(1, math.ceil(quantile * len(ordered))) - 1]


def _cited(trace: RagTrace, span_document: str, span_document_id: str | None) -> bool:
    for citation in trace.citations:
        if span_document_id and citation.documentId == span_document_id:
            return True
        if citation.documentName == span_document:
            return True
    return False


def score_candidate(
    traces: Sequence[RagTrace], golden: Sequence[GoldenItem], *, mode: Mode, cap: int | None
) -> CandidateResult:
    """The five D-34 quantities over the answered traces; correctness and citation recall over answerable items with evidence."""
    by_id = {trace.item_id: trace for trace in traces if trace.item_id is not None}
    correctness: list[float] = []
    recall: list[float] = []
    for item in golden:
        if not item.answerable or not item.gold_evidence:
            continue
        trace = by_id.get(item.id)
        if trace is None:
            raise OutputCapSweepError(f"the harness returned no trace for dev item {item.id!r}")
        answer = "" if trace.refused or trace.answer is None else _normalize(trace.answer)
        spans = item.gold_evidence
        correctness.append(sum(1 for span in spans if answer and _normalize(span.quote) in answer) / len(spans))
        documents = {(span.document, span.document_id) for span in spans}
        hits = 0 if trace.refused else sum(1 for name, doc_id in documents if _cited(trace, name, doc_id))
        recall.append(hits / len(documents))
    if not correctness:
        raise OutputCapSweepError("the dev split holds no answerable item with gold evidence to score")
    answered = [trace for trace in traces if trace.answer is not None]
    finished = [trace for trace in answered if trace.finish_reason is not None]
    if answered and not finished:
        raise OutputCapSweepError("the harness recorded no finish_reason on the answers; the truncation rule cannot be checked")
    if not answered:
        raise OutputCapSweepError("the harness returned no answer; the output-cap sweep needs the answer tier")
    tokens = [len(trace.answer.split()) for trace in answered if trace.answer is not None]
    latencies = [
        value
        for trace in answered
        for stage, value in trace.stage_latency_ms.items()
        if stage == GENERATION_STAGE and math.isfinite(value) and value >= 0
    ]
    truncated = sum(1 for trace in finished if trace.finish_reason == LENGTH_FINISH)
    return CandidateResult(
        mode=mode,
        cap=cap,
        answer_correctness=sum(correctness) / len(correctness),
        citation_recall=sum(recall) / len(recall),
        mean_output_tokens=sum(tokens) / len(tokens) if tokens else 0.0,
        generation_latency_p95_ms=_nearest_rank(latencies, 0.95) if latencies else 0.0,
        truncation_rate=truncated / len(finished),
        n_answers=len(answered),
        n_scored=len(correctness),
    )


def _canonical_sha(payload: object) -> str:
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _load_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise OutputCapSweepError(f"{label} {path} is unreadable: {exc}") from exc
    if not isinstance(payload, dict):
        raise OutputCapSweepError(f"{label} {path} must be a JSON object")
    return payload


def load_live_urls(path: Path, candidates: Sequence[int]) -> dict[str, str]:
    """A live sweep runs each candidate against a deployment with that RAG_MAX_OUTPUT_TOKENS: {"off": url, "<cap>": url}."""
    payload = _load_json_object(path, "--live-urls")
    wanted = [UNCAPPED, *(str(cap) for cap in candidates)]
    missing = [key for key in wanted if not isinstance(payload.get(key), str) or not payload[key].strip()]
    if missing:
        raise OutputCapSweepError(f"--live-urls names no base URL for: {', '.join(missing)}")
    return {key: payload[key].strip() for key in wanted}


def _require_dev_only(items: Sequence[GoldenItem]) -> None:
    leaked = [item.id for item in items if assign_split(item.id) != "dev" or item.split != "dev"]
    if leaked:
        raise OutputCapSweepError(f"the harness golden file carries non-dev items: {', '.join(sorted(leaked)[:5])}")


def _is_committed(path: Path) -> bool:
    return Path(path).resolve() == CAPS_PATH.resolve()


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def render_markdown(result: OutputCapSweepResult) -> str:
    lines = ["# Output-cap sweep", ""]
    lines.append(
        f"Mode: {result.mode}"
        + ("" if result.mode == "live" else " (fixture numbers prove the tooling only; the committed caps stay off)")
    )
    lines += ["", f"Selection rule: {result.rule}", "", result.token_note, ""]
    lines.append(f"- run config: {result.run_config_name} (sha256 {result.run_config_sha256})")
    lines.append(f"- golden (dev items): sha256 {result.golden_sha256}")
    lines.append(f"- candidates: {result.candidates}; truncation limit {result.truncation_rate_limit:.0%}")
    lines.append("")
    chosen = {selection.mode: selection.limit for selection in result.selections}
    lines.append(
        "| Mode | Cap | Correctness | Citation recall | Output tokens | Generation p95 (ms) | Truncation | Answers | Chosen |"
    )
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for row in result.results:
        cap = UNCAPPED if row.cap is None else str(row.cap)
        mark = "chosen" if row.cap is not None and chosen.get(row.mode) == row.cap else ""
        lines.append(
            f"| {row.mode} | {cap} | {row.answer_correctness:.4f} | {row.citation_recall:.4f} | {row.mean_output_tokens:.1f} | "
            f"{row.generation_latency_p95_ms:.1f} | {row.truncation_rate:.4f} | {row.n_answers} | {mark} |"
        )
    lines.append("")
    for selection in result.selections:
        verdict = f"cap {selection.limit}" if selection.limit is not None else "off (no qualifying cap)"
        lines.append(f"- {selection.mode}: {verdict}; noise band {selection.noise_band:.4f}")
        for cap, failed in sorted(selection.reasons.items(), key=lambda pair: int(pair[0])):
            lines.append(f"  - {cap}: {', '.join(failed)}")
    lines.append("")
    lines.append(
        "Caps file: "
        + (f"written to {result.caps_path}." if result.caps_written else "not written.")
    )
    if result.notes:
        lines.append("")
        lines.extend(f"- {note}" for note in result.notes)
    return "\n".join(lines) + "\n"


def run_output_cap_sweep(
    run_config: Path,
    out: Path,
    report_dir: Path,
    *,
    candidates: Sequence[int] = DEFAULT_CANDIDATES,
    modes: Sequence[Mode] = DEFAULT_MODES,
    live_urls: dict[str, str] | None = None,
    runner: Callable[..., HarnessRun] = run_harness,
    golden: Path = DEFAULT_GOLDEN,
    fixture_mode: str | None = None,
    noise_path: Path = NOISE_PATH,
) -> OutputCapSweepResult:
    caps = validate_candidates(candidates)
    live = live_urls is not None
    if _is_committed(out) and not live:
        raise OutputCapSweepError(
            f"a fixture sweep never writes {repo_relative(CAPS_PATH)}; pass --out with another path or run live with --live-urls"
        )
    if not modes or any(mode not in DEFAULT_MODES for mode in modes):
        raise OutputCapSweepError("--modes must name strict and/or balanced")
    try:
        noise = NoiseConfig.model_validate_json(Path(noise_path).read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        raise OutputCapSweepError(f"noise config {noise_path} is unreadable: {exc}") from exc
    config_payload = _load_json_object(run_config, "run-config")
    existing: OutputCaps | None = None
    if Path(out).is_file():
        try:
            existing = OutputCaps.model_validate_json(Path(out).read_text(encoding="utf-8"))
        except (OSError, ValidationError, ValueError) as exc:
            raise OutputCapSweepError(f"{out} is not a valid output-caps file: {exc}") from exc

    report = Path(report_dir)
    results: list[CandidateResult] = []
    golden_hashes: set[str] = set()
    notes: list[str] = []
    ordered_modes: list[Mode] = [mode for mode in DEFAULT_MODES if mode in modes]
    for mode in ordered_modes:
        for cap in (None, *caps):
            key = UNCAPPED if cap is None else str(cap)
            cell_dir = report / "runs" / f"{mode}-{key}"
            run = runner(
                run_config=Path(run_config),
                golden=Path(golden),
                out=cell_dir,
                base_url=live_urls[key] if live_urls else None,
                fixture_mode=fixture_mode,
                env_overlay=None if live else {"RAG_MAX_OUTPUT_TOKENS": key},
                answers=True,
                rag_mode=mode,
            )
            items = load_golden(run.golden_path)
            _require_dev_only(items)
            golden_hashes.add(golden_sha256(run.golden_path))
            scored = score_candidate(run.traces, items, mode=mode, cap=cap)
            results.append(
                scored.model_copy(
                    update={
                        "run_id": run.report.run_id if run.report is not None else None,
                        "run_config_hash": run.report.run_config_hash if run.report is not None else None,
                        "out_dir": repo_relative(cell_dir),
                    }
                )
            )
            for note in run.notes:
                if note not in notes:
                    notes.append(note)
    if len(golden_hashes) != 1:
        raise OutputCapSweepError("the runs did not all use the same dev golden file")

    selections = [select_cap(results, noise, mode) for mode in ordered_modes]
    caps_file = build_caps(selections, existing)
    if not live:
        notes.append("Fixture run: the committed output-caps.json is never written by a fixture sweep (D-29).")
    write_config_atomically(Path(out), caps_file)
    result = OutputCapSweepResult(
        mode="live" if live else "fixture",
        run_config_name=str(config_payload.get("name", "")),
        run_config_sha256=_canonical_sha(config_payload),
        golden_sha256=next(iter(golden_hashes)),
        candidates=list(caps),
        modes=ordered_modes,
        results=results,
        selections=selections,
        caps=caps_file.model_dump(mode="json"),
        caps_written=True,
        caps_path=repo_relative(Path(out)),
        notes=notes,
    )
    _write_text(
        report / RESULT_NAME, json.dumps(result.model_dump(mode="json"), sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    )
    _write_text(report / REPORT_NAME, render_markdown(result))
    return result


def _int_list(text: str) -> tuple[int, ...]:
    try:
        return tuple(int(part) for part in text.split(",") if part.strip())
    except ValueError as exc:
        raise OutputCapSweepError("--candidates must be a comma-separated list of integers") from exc


def _output_cap(args: argparse.Namespace) -> int:
    try:
        candidates = _int_list(args.candidates) if args.candidates else DEFAULT_CANDIDATES
        validate_candidates(candidates)
        modes = tuple(part.strip() for part in args.modes.split(",") if part.strip())
        live_urls = load_live_urls(resolve_cli_path(args.live_urls), candidates) if args.live_urls else None
        result = run_output_cap_sweep(
            resolve_cli_path(args.run_config),
            resolve_cli_path(args.out),
            resolve_cli_path(args.report_dir),
            candidates=candidates,
            modes=modes,  # type: ignore[arg-type]
            live_urls=live_urls,
            golden=resolve_cli_path(args.golden),
            fixture_mode=args.fixture_mode,
        )
    except OutputCapSweepError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_HARNESS
    chosen = ", ".join(
        f"{selection.mode}={'off' if selection.limit is None else selection.limit}" for selection in result.selections
    )
    print(f"[Output Cap Sweep] {result.mode}: {len(result.results)} runs; {chosen}; written to {result.caps_path}")
    return EXIT_OK


def register(commands: Any) -> None:
    cmd = commands.add_parser("output-cap", help="choose the per-mode output cap from answer-tier runs (D-34)")
    cmd.add_argument("--run-config", type=Path, default=DEFAULT_RUN_CONFIG)
    cmd.add_argument(
        "--out",
        type=Path,
        default=CAPS_PATH,
        help="the caps file to write (default eval/config/output-caps.json; a fixture sweep must name another path)",
    )
    cmd.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    cmd.add_argument("--golden", type=Path, default=DEFAULT_GOLDEN)
    cmd.add_argument("--fixture-mode", choices=("prechunked", "ingest"), default=None)
    cmd.add_argument("--candidates", default=None, help="comma-separated caps (default 512,768,1024,1536,2048)")
    cmd.add_argument("--modes", default="strict,balanced")
    cmd.add_argument(
        "--live-urls",
        type=Path,
        default=None,
        help='JSON {"off": url, "<cap>": url}: one deployment per candidate with that RAG_MAX_OUTPUT_TOKENS (live sweep)',
    )
    cmd.set_defaults(handler=_output_cap)
