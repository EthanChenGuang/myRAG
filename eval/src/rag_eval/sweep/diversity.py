"""D-21, D-48: MMR lambda sweep on the dev split with a pre-registered choice rule.

A fixture run may write the chosen lambda into the run config it was given (eval only); only a live run (--base-url) with
--write-params writes `mmr_lambda` into eval/config/retrieval-params.json.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.report import EvalReport, SliceMetrics
from rag_sidecar.contracts.retrieval import RetrievalParams

from rag_eval.config_files import finalize_config, write_config_atomically
from rag_eval.harness_runner import HarnessError, HarnessRun, run_harness
from rag_eval.paths import REPO_ROOT, repo_relative, resolve_cli_path
from rag_eval.sweep.retrieval import EXIT_HARNESS, EXIT_OK, EXIT_USAGE, SweepUsageError, noise_band

LAMBDA_GRID = (0.5, 0.6, 0.7, 0.8, 0.9)
DEFAULT_LAMBDA = 0.7
PARAMS_PATH = REPO_ROOT / "eval" / "config" / "retrieval-params.json"
NOISE_PATH = REPO_ROOT / "eval" / "config" / "noise.json"
DEFAULT_GOLDEN = REPO_ROOT / "eval" / "fixtures" / "golden.jsonl"
REPORT_NAME = "diversity-sweep.md"
RESULT_NAME = "diversity-sweep.json"
DUPLICATE_FLOOD = "duplicate_flood"
EPSILON = 1e-9
REFERENCE_ENV = {"RAG_RESULT_DIVERSITY": "collapse", "RAG_DUP_CLUSTERS": "true"}
CELL_ENV = {"RAG_RESULT_DIVERSITY": "mmr", "RAG_DUP_CLUSTERS": "true"}
WRITE_PARAMS_REFUSAL = "--write-params needs a live --base-url: a fixture run can never replace the committed retrieval params"

CHOICE_RULE = (
    "A lambda is eligible when no slice (overall, every language, every category) drops on Recall@10 beyond the noise band "
    "against the reference run (the same run config with RAG_RESULT_DIVERSITY=collapse). Among eligible lambdas take the "
    "highest duplicate_flood intent_coverage, then the lowest duplicate_flood topk_redundancy, then the highest mean Recall@10 "
    "over all slices, then the largest lambda. No eligible lambda: no choice, nothing written, the default 0.7 stays."
)
NDCG_NOTE = "nDCG@k per slice is report-only: it is not a selection criterion."
DEV_ONLY_RULE = "Scope: dev split only; the test split is never read."


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class DiversityCell(_Model):
    mmr_lambda: float | None
    recall_at_10: dict[str, float | None]
    ndcg_at_context_k: dict[str, float | None]
    dup_intent_coverage: float | None
    dup_topk_redundancy: float | None
    mean_recall_at_10: float | None
    run_config_hash: str | None
    out_dir: str


class LambdaSelection(_Model):
    chosen: float | None
    eligible: list[float]
    noise_band: float
    reasons: list[str]


class DiversitySweepResult(_Model):
    mode: str
    run_config_name: str
    grid: list[float]
    rule: str
    reference: DiversityCell
    cells: list[DiversityCell]
    selection: LambdaSelection
    notes: list[str]
    run_config_written: bool = False
    params_written: bool = False
    params_path: str | None = None


def _slices(report: EvalReport) -> dict[str, SliceMetrics]:
    slices: dict[str, SliceMetrics] = {"overall": report.overall}
    slices.update({f"language:{name}": metrics for name, metrics in sorted(report.by_language.items())})
    slices.update({f"category:{name}": metrics for name, metrics in sorted(report.by_category.items())})
    return slices


def _value(metric: Any) -> float | None:
    return None if metric is None else metric.value


def cell_from_report(mmr_lambda: float | None, report: EvalReport, out_dir: str) -> DiversityCell:
    slices = _slices(report)
    recall = {name: _value(metrics.recall_at_10) for name, metrics in slices.items()}
    present = [value for value in recall.values() if value is not None]
    dup = report.by_category.get(DUPLICATE_FLOOD)
    return DiversityCell(
        mmr_lambda=mmr_lambda,
        recall_at_10=recall,
        ndcg_at_context_k={name: _value(metrics.ndcg_at_context_k) for name, metrics in slices.items()},
        dup_intent_coverage=_value(dup.intent_coverage) if dup is not None else None,
        dup_topk_redundancy=_value(dup.topk_redundancy) if dup is not None else None,
        mean_recall_at_10=sum(present) / len(present) if present else None,
        run_config_hash=report.run_config_hash,
        out_dir=out_dir,
    )


def _drops(cell: DiversityCell, reference: DiversityCell, band: float) -> list[str]:
    out: list[str] = []
    for name, ref in sorted(reference.recall_at_10.items()):
        if ref is None:
            continue
        observed = cell.recall_at_10.get(name)
        if observed is None:
            out.append(f"{name}: missing (reference {ref:.4f})")
        elif observed < ref - band - EPSILON:
            out.append(f"{name}: {observed:.4f} < {ref:.4f} - {band:.4f}")
    return out


def choose_lambda(cells: Sequence[DiversityCell], reference: DiversityCell, noise: NoiseConfig) -> LambdaSelection:
    band = noise_band(noise)
    eligible: list[DiversityCell] = []
    reasons: list[str] = []
    for cell in cells:
        drops = _drops(cell, reference, band)
        if drops:
            reasons.append(f"lambda {cell.mmr_lambda}: ineligible, Recall@10 drop beyond the band: {'; '.join(drops)}")
        else:
            eligible.append(cell)
    if not eligible:
        reasons.append(f"no eligible lambda: nothing chosen, the default {DEFAULT_LAMBDA} stays")
        return LambdaSelection(chosen=None, eligible=[], noise_band=band, reasons=reasons)

    def key(cell: DiversityCell) -> tuple[float, float, float, float]:
        coverage = cell.dup_intent_coverage if cell.dup_intent_coverage is not None else -math.inf
        redundancy = cell.dup_topk_redundancy if cell.dup_topk_redundancy is not None else math.inf
        recall = cell.mean_recall_at_10 if cell.mean_recall_at_10 is not None else -math.inf
        return (-coverage, redundancy, -recall, -(cell.mmr_lambda or 0.0))

    best = sorted(eligible, key=key)[0]
    reasons.append(
        f"chosen lambda {best.mmr_lambda}: duplicate_flood intent_coverage {best.dup_intent_coverage}, "
        f"topk_redundancy {best.dup_topk_redundancy}, mean Recall@10 {best.mean_recall_at_10}"
    )
    return LambdaSelection(
        chosen=best.mmr_lambda, eligible=sorted(cell.mmr_lambda for cell in eligible if cell.mmr_lambda is not None), noise_band=band, reasons=reasons
    )


def _load_run_config(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SweepUsageError(f"run-config {path} is unreadable: {exc}") from exc
    if not isinstance(payload, dict):
        raise SweepUsageError(f"run-config {path} must be a JSON object")
    return payload


def _require_dev_only(report: EvalReport) -> None:
    leaked = sorted(split for split in report.by_split if split != "dev")
    if leaked:
        raise SweepUsageError(f"the harness report carries non-dev splits ({', '.join(leaked)}); the test split must never be read")


def _write_json_atomically(path: Path, payload: dict[str, Any]) -> None:
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def write_run_config_lambda(path: Path, mmr_lambda: float) -> None:
    """Sets overrides.diversity.mmr_lambda in the given run config; every other key stays as it was."""
    payload = _load_run_config(path)
    overrides = dict(payload.get("overrides") or {})
    block = dict(overrides.get("diversity") or {})
    block["mmr_lambda"] = mmr_lambda
    overrides["diversity"] = block
    payload["overrides"] = overrides
    _write_json_atomically(Path(path), payload)


def _proposed_params(params_path: Path, mmr_lambda: float) -> RetrievalParams:
    path = Path(params_path)
    base = RetrievalParams.model_validate_json(path.read_text(encoding="utf-8")) if path.is_file() else RetrievalParams()
    moved = RetrievalParams.model_validate({**base.model_dump(mode="json"), "mmr_lambda": mmr_lambda})
    return finalize_config(moved, provenance_source="sweep")


def _cell_text(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.4f}"


def render_markdown(result: DiversitySweepResult) -> str:
    slices = sorted(result.reference.recall_at_10)
    lines = [
        "# MMR lambda sweep",
        "",
        f"- Mode: {result.mode}",
        f"- Run config: {result.run_config_name}",
        f"- Grid: {', '.join(f'{lam:.1f}' for lam in result.grid)}",
        f"- Noise band: {result.selection.noise_band:.4f}",
        f"- {DEV_ONLY_RULE}",
        "",
        "## Choice rule",
        "",
        result.rule,
        "",
        "## Result",
        "",
    ]
    if result.selection.chosen is None:
        lines.append(f"No lambda chosen: no eligible lambda. The default {DEFAULT_LAMBDA} stays.")
    else:
        lines.append(f"Chosen lambda: {result.selection.chosen:.1f}")
    lines += [f"- {reason}" for reason in result.selection.reasons]
    lines += ["", "| lambda | duplicate_flood intent_coverage | duplicate_flood topk_redundancy | mean Recall@10 | eligible |", "| --- | --- | --- | --- | --- |"]
    for cell in [result.reference, *result.cells]:
        label = "collapse (reference)" if cell.mmr_lambda is None else f"{cell.mmr_lambda:.1f}"
        eligible = "" if cell.mmr_lambda is None else ("yes" if cell.mmr_lambda in result.selection.eligible else "no")
        lines.append(
            f"| {label} | {_cell_text(cell.dup_intent_coverage)} | {_cell_text(cell.dup_topk_redundancy)} | {_cell_text(cell.mean_recall_at_10)} | {eligible} |"
        )
    for title, field in (("Recall@10 per slice", "recall_at_10"), ("nDCG@k per slice", "ndcg_at_context_k")):
        lines += ["", f"## {title}", ""]
        if field == "ndcg_at_context_k":
            lines += [NDCG_NOTE, ""]
        lines.append("| lambda | " + " | ".join(slices) + " |")
        lines.append("| --- | " + " | ".join("---" for _ in slices) + " |")
        for cell in [result.reference, *result.cells]:
            label = "collapse" if cell.mmr_lambda is None else f"{cell.mmr_lambda:.1f}"
            values = getattr(cell, field)
            lines.append(f"| {label} | " + " | ".join(_cell_text(values.get(name)) for name in slices) + " |")
    if result.notes:
        lines += ["", "## Notes", ""] + [f"- {note}" for note in result.notes]
    return "\n".join(lines) + "\n"


def run_diversity_sweep(
    run_config: Path,
    out: Path,
    *,
    base_url: str | None = None,
    write_run_config: bool = False,
    write_params: bool = False,
    runner: Callable[..., HarnessRun] = run_harness,
    golden: Path = DEFAULT_GOLDEN,
    fixture_mode: str | None = None,
    params_path: Path = PARAMS_PATH,
    noise_path: Path = NOISE_PATH,
) -> DiversitySweepResult:
    if write_params and not base_url:
        raise SweepUsageError(WRITE_PARAMS_REFUSAL)
    if write_run_config and base_url:
        raise SweepUsageError("--write-run-config is for fixture runs; a live run writes the shipped value with --write-params")
    try:
        noise = NoiseConfig.model_validate_json(Path(noise_path).read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        raise SweepUsageError(f"noise config {noise_path} is unreadable: {exc}") from exc
    payload = _load_run_config(run_config)
    base_diversity = dict((payload.get("overrides") or {}).get("diversity") or {})
    out_dir = Path(out)
    notes: list[str] = []

    def run(cell_dir: Path, overrides: dict[str, Any] | None, env: dict[str, str]) -> HarnessRun:
        result = runner(
            run_config=Path(run_config),
            golden=Path(golden),
            out=cell_dir,
            overrides=overrides,
            base_url=base_url,
            fixture_mode=fixture_mode,
            env_overlay=dict(env),
            splits=("dev",),
        )
        if result.report is None:
            raise HarnessError(f"the harness wrote no report in {cell_dir}", exit_code=0)
        _require_dev_only(result.report)
        for note in result.notes:
            if note not in notes:
                notes.append(note)
        return result

    reference_dir = out_dir / "cells" / "reference-collapse"
    reference = cell_from_report(None, run(reference_dir, None, REFERENCE_ENV).report, repo_relative(reference_dir))  # type: ignore[arg-type]
    cells: list[DiversityCell] = []
    for lam in LAMBDA_GRID:
        cell_dir = out_dir / "cells" / f"lambda-{lam:.1f}"
        overrides = {"diversity": {**base_diversity, "mmr_lambda": lam}}
        report = run(cell_dir, overrides, CELL_ENV).report
        cells.append(cell_from_report(lam, report, repo_relative(cell_dir)))  # type: ignore[arg-type]

    selection = choose_lambda(cells, reference, noise)
    live = bool(base_url)
    if live:
        notes.append("Live run: the deployed environment must have RAG_RESULT_DIVERSITY and RAG_DUP_CLUSTERS set per cell; the env overlay applies in-process only.")
    else:
        notes.append("Fixture run: eval/config/retrieval-params.json was not touched.")
    result = DiversitySweepResult(
        mode="live" if live else "fixture",
        run_config_name=str(payload.get("name", "")),
        grid=list(LAMBDA_GRID),
        rule=CHOICE_RULE,
        reference=reference,
        cells=cells,
        selection=selection,
        notes=notes,
    )
    if selection.chosen is not None:
        if write_run_config:
            write_run_config_lambda(Path(run_config), selection.chosen)
            result = result.model_copy(update={"run_config_written": True})
        if write_params:
            write_config_atomically(Path(params_path), _proposed_params(params_path, selection.chosen))
            result = result.model_copy(update={"params_written": True, "params_path": repo_relative(params_path)})

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / RESULT_NAME).write_text(json.dumps(result.model_dump(mode="json"), sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (out_dir / REPORT_NAME).write_text(render_markdown(result), encoding="utf-8")
    return result


def diversity_command(args: argparse.Namespace) -> int:
    try:
        if args.write_params and not args.base_url:
            raise SweepUsageError(WRITE_PARAMS_REFUSAL)
        result = run_diversity_sweep(
            resolve_cli_path(args.run_config),
            resolve_cli_path(args.out),
            base_url=args.base_url,
            write_run_config=args.write_run_config,
            write_params=args.write_params,
            golden=resolve_cli_path(args.golden),
            fixture_mode=args.fixture_mode,
        )
    except SweepUsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_HARNESS
    chosen = result.selection.chosen
    print(
        f"[Diversity Sweep] {result.mode}: chosen lambda {chosen if chosen is not None else 'none'}; "
        f"run config written: {'yes' if result.run_config_written else 'no'}; params written: {'yes' if result.params_written else 'no'}"
    )
    return EXIT_OK


def register(commands: Any) -> None:
    cmd = commands.add_parser("diversity", help="sweep the MMR lambda (0.5..0.9) on the dev split")
    cmd.add_argument("--run-config", required=True, type=Path)
    cmd.add_argument("--out", required=True, type=Path)
    cmd.add_argument("--golden", type=Path, default=DEFAULT_GOLDEN)
    cmd.add_argument("--base-url", default=None)
    cmd.add_argument("--fixture-mode", choices=("prechunked", "ingest"), default=None)
    cmd.add_argument("--write-run-config", action="store_true", help="fixture run: set overrides.diversity.mmr_lambda in --run-config")
    cmd.add_argument("--write-params", action="store_true", help="live run only: write mmr_lambda into eval/config/retrieval-params.json")
    cmd.set_defaults(handler=diversity_command)
