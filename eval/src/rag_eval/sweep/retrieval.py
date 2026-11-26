from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Callable, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.retrieval import RetrievalParams

from rag_eval.config_files import finalize_config, write_config_atomically
from rag_eval.golden_io import golden_sha256, load_golden
from rag_eval.harness_runner import HarnessError, HarnessRun, run_harness
from rag_eval.matching import chunk_matches_span
from rag_eval.paths import REPO_ROOT, repo_relative, resolve_cli_path
from rag_eval.split import assign_split

DEFAULT_POOLS = (25, 50, 75, 100)
DEFAULT_TOP_KS = (5, 8, 10, 15, 20)
CAP_MIN = 25
CAP_MAX = 100
PARAMS_PATH = REPO_ROOT / "eval" / "config" / "retrieval-params.json"
NOISE_PATH = REPO_ROOT / "eval" / "config" / "noise.json"
DEFAULT_GOLDEN = REPO_ROOT / "eval" / "fixtures" / "golden.jsonl"
RESULT_NAME = "retrieval-sweep.json"
REPORT_NAME = "retrieval-sweep.md"
GENERATION_STAGE = "generation"
EPSILON = 1e-9

SELECTION_RULE = (
    "Smallest candidate pool whose Recall@k and MRR are both within the noise band of the best cell; "
    "ties on pool size go to the lower mean context tokens, then the lower latency p95."
)
DEV_ONLY_RULE = "Scope: dev split only; the test split is never read (D-14)."

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_HARNESS = 3


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SweepUsageError(Exception):
    pass


class SweepGrid(_Model):
    pools: tuple[int, ...] = DEFAULT_POOLS
    top_ks: tuple[int, ...] = DEFAULT_TOP_KS

    @field_validator("pools")
    @classmethod
    def _pools(cls, values: tuple[int, ...]) -> tuple[int, ...]:
        if not values or any(value < 1 or value > 200 for value in values):
            raise ValueError("pools must be a non-empty list of candidate pool sizes from 1 to 200")
        return tuple(sorted(set(values)))

    @field_validator("top_ks")
    @classmethod
    def _top_ks(cls, values: tuple[int, ...]) -> tuple[int, ...]:
        if not values or any(value < 1 or value > 100 for value in values):
            raise ValueError("top_ks must be a non-empty list of final top-k values from 1 to 100")
        return tuple(sorted(set(values)))


class SweepCell(_Model):
    candidate_pool_size: int = Field(ge=1, le=200)
    rerank_input_cap: int = Field(ge=CAP_MIN, le=CAP_MAX)
    final_top_k: int = Field(ge=1, le=100)
    recall_at_k: float
    mrr: float
    mean_context_tokens: float = Field(ge=0)
    latency_p95_ms: float = Field(ge=0)
    n_items: int = Field(ge=0)
    run_config_hash: str | None = None
    out_dir: str | None = None


class Selection(_Model):
    chosen: SweepCell
    noise_band: float
    best_recall: float
    best_mrr: float
    within_band: list[tuple[int, int]]


class NoiseRecord(_Model):
    floor: float
    k: float
    spread: float
    band: float


class SweepResult(_Model):
    schema_version: int = 1
    mode: str
    dev_only: bool = True
    rule: str = SELECTION_RULE
    run_config_name: str = ""
    run_config_sha256: str = ""
    golden_sha256: str = ""
    grid_sha256: str = ""
    grid: SweepGrid = Field(default_factory=SweepGrid)
    noise: NoiseRecord | None = None
    cells: list[SweepCell] = Field(default_factory=list)
    selection: Selection | None = None
    proposed_params: dict[str, Any] | None = None
    params_written: bool = False
    params_path: str | None = None
    notes: list[str] = Field(default_factory=list)


def rerank_cap(pool: int) -> int:
    return min(CAP_MAX, max(CAP_MIN, pool))


def noise_band(noise: NoiseConfig, spread: float = 0.0) -> float:
    """The band the gate uses: max(k * spread, floor)."""
    return max(noise.k * spread, noise.floor)


def choose_configuration(cells: Sequence[SweepCell], noise: NoiseConfig, spread: float = 0.0) -> Selection:
    if not cells:
        raise ValueError("no sweep cells to choose from")
    band = noise_band(noise, spread)
    best_recall = max(cell.recall_at_k for cell in cells)
    best_mrr = max(cell.mrr for cell in cells)
    eligible = [
        cell
        for cell in cells
        if cell.recall_at_k >= best_recall - band - EPSILON and cell.mrr >= best_mrr - band - EPSILON
    ]
    ordered = sorted(
        eligible,
        key=lambda cell: (cell.candidate_pool_size, cell.mean_context_tokens, cell.latency_p95_ms, cell.final_top_k),
    )
    return Selection(
        chosen=ordered[0],
        noise_band=band,
        best_recall=best_recall,
        best_mrr=best_mrr,
        within_band=sorted((cell.candidate_pool_size, cell.final_top_k) for cell in eligible),
    )


def _first_hit_ranks(trace: RagTrace, item: GoldenItem) -> list[int | None]:
    ranked = sorted(trace.kept, key=lambda chunk: chunk.rank)
    ranks: list[int | None] = []
    for span in item.gold_evidence:
        found = None
        for position, chunk in enumerate(ranked, start=1):
            if chunk_matches_span(chunk.document_name or "", chunk.content, span):
                found = position
                break
        ranks.append(found)
    return ranks


def cell_scores(traces: Sequence[RagTrace], golden: Sequence[GoldenItem], top_k: int) -> tuple[float, float, int]:
    """Recall of gold spans inside the final top-k and MRR over answerable items; a refused item scores zero."""
    by_id = {trace.item_id: trace for trace in traces if trace.item_id is not None}
    recalls: list[float] = []
    reciprocals: list[float] = []
    for item in golden:
        if not item.answerable or not item.gold_evidence:
            continue
        trace = by_id.get(item.id)
        if trace is None:
            raise SweepUsageError(f"the harness returned no trace for dev item {item.id!r}")
        hits = [] if trace.refused else [rank for rank in _first_hit_ranks(trace, item) if rank is not None and rank <= top_k]
        recalls.append(len(hits) / len(item.gold_evidence))
        reciprocals.append(1 / min(hits) if hits else 0.0)
    if not recalls:
        raise SweepUsageError("the dev split holds no answerable item to score")
    return sum(recalls) / len(recalls), sum(reciprocals) / len(reciprocals), len(recalls)


def _nearest_rank(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    return ordered[max(1, math.ceil(quantile * len(ordered))) - 1]


def _mean_context_tokens(traces: Sequence[RagTrace]) -> float:
    counts = [trace.context_tokens if trace.context_tokens is not None else len(trace.context) / 4 for trace in traces]
    return sum(counts) / len(counts) if counts else 0.0


def _latency_p95(traces: Sequence[RagTrace]) -> float:
    totals: list[float] = []
    for trace in traces:
        values = [
            value
            for stage, value in trace.stage_latency_ms.items()
            if stage != GENERATION_STAGE and math.isfinite(value) and value >= 0
        ]
        if values:
            totals.append(sum(values))
    return _nearest_rank(totals, 0.95) if totals else 0.0


def _canonical_sha(payload: object) -> str:
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _load_run_config(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SweepUsageError(f"run-config {path} is unreadable: {exc}") from exc
    if not isinstance(payload, dict):
        raise SweepUsageError(f"run-config {path} must be a JSON object")
    return payload


def _require_dev_only(items: Sequence[GoldenItem]) -> None:
    leaked = [item.id for item in items if assign_split(item.id) != "dev" or item.split != "dev"]
    if leaked:
        raise SweepUsageError(
            f"the harness golden file carries non-dev items (test split must never be read): {', '.join(sorted(leaked)[:5])}"
        )


def _proposed_params(selection: Selection, params_path: Path) -> RetrievalParams:
    path = Path(params_path)
    base = RetrievalParams.model_validate_json(path.read_text(encoding="utf-8")) if path.is_file() else RetrievalParams()
    chosen = selection.chosen
    moved = base.model_copy(
        update={
            "candidate_pool_size": chosen.candidate_pool_size,
            "rerank_input_cap": chosen.rerank_input_cap,
            "final_top_k": chosen.final_top_k,
        }
    )
    validated = RetrievalParams.model_validate(moved.model_dump(mode="json"))
    return finalize_config(validated, provenance_source="sweep")


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def render_markdown(result: SweepResult) -> str:
    lines = ["# Retrieval sweep", ""]
    live = result.mode == "live"
    lines.append(
        f"Mode: {result.mode}"
        + ("" if live else " (fixture numbers prove the tooling only; they never replace the committed params)")
    )
    lines.append("")
    lines.append(DEV_ONLY_RULE)
    lines.append("")
    lines.append(f"Selection rule: {result.rule}")
    lines.append("")
    lines.append(f"- run config: {result.run_config_name} (sha256 {result.run_config_sha256})")
    lines.append(f"- golden (dev items): sha256 {result.golden_sha256}")
    lines.append(f"- grid: pools {list(result.grid.pools)}, top-k {list(result.grid.top_ks)} (sha256 {result.grid_sha256})")
    if result.noise is not None:
        lines.append(
            f"- noise band: {result.noise.band:.4f} = max(k {result.noise.k} x spread {result.noise.spread:.4f}, floor {result.noise.floor})"
        )
    lines.append("")
    selection = result.selection
    in_band = set(selection.within_band) if selection is not None else set()
    chosen = (selection.chosen.candidate_pool_size, selection.chosen.final_top_k) if selection is not None else None
    lines.append("| Pool | Cap | Top-k | Recall@k | MRR | Context tokens | Latency p95 (ms) | In band | Chosen |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for cell in result.cells:
        key = (cell.candidate_pool_size, cell.final_top_k)
        lines.append(
            f"| {cell.candidate_pool_size} | {cell.rerank_input_cap} | {cell.final_top_k} | {cell.recall_at_k:.4f} | "
            f"{cell.mrr:.4f} | {cell.mean_context_tokens:.1f} | {cell.latency_p95_ms:.1f} | "
            f"{'yes' if key in in_band else 'no'} | {'chosen' if key == chosen else ''} |"
        )
    lines.append("")
    if selection is not None:
        picked = selection.chosen
        lines.append(
            f"Chosen: pool {picked.candidate_pool_size}, rerank input cap {picked.rerank_input_cap}, "
            f"top-k {picked.final_top_k} (best Recall@k {selection.best_recall:.4f}, best MRR {selection.best_mrr:.4f})."
        )
        lines.append("")
    lines.append(
        "Params file: "
        + (f"written to {result.params_path}." if result.params_written else "not written (needs --write-params and a live --base-url).")
    )
    if result.notes:
        lines.append("")
        lines.extend(f"- {note}" for note in result.notes)
    return "\n".join(lines) + "\n"


def run_retrieval_sweep(
    run_config: Path,
    grid: SweepGrid,
    out: Path,
    base_url: str | None = None,
    write_params: bool = False,
    runner: Callable[..., HarnessRun] = run_harness,
    golden: Path = DEFAULT_GOLDEN,
    fixture_mode: str | None = None,
    params_path: Path = PARAMS_PATH,
    noise_path: Path = NOISE_PATH,
) -> SweepResult:
    if write_params and not base_url:
        raise SweepUsageError(
            "--write-params needs a live --base-url: a fixture run can never replace the committed retrieval params"
        )
    out_dir = Path(out)
    try:
        noise = NoiseConfig.model_validate_json(Path(noise_path).read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        raise SweepUsageError(f"noise config {noise_path} is unreadable: {exc}") from exc
    config_payload = _load_run_config(run_config)

    cells: list[SweepCell] = []
    golden_hashes: set[str] = set()
    notes: list[str] = []
    for pool in grid.pools:
        for top_k in grid.top_ks:
            overrides = {
                "candidate_pool_size": pool,
                "rerank_input_cap": rerank_cap(pool),
                "final_top_k": top_k,
            }
            cell_dir = out_dir / "cells" / f"pool-{pool}_k-{top_k}"
            run = runner(
                run_config=Path(run_config),
                golden=Path(golden),
                out=cell_dir,
                overrides=overrides,
                base_url=base_url,
                fixture_mode=fixture_mode,
            )
            items = load_golden(run.golden_path)
            _require_dev_only(items)
            golden_hashes.add(golden_sha256(run.golden_path))
            recall, mrr, n_items = cell_scores(run.traces, items, top_k)
            cells.append(
                SweepCell(
                    candidate_pool_size=pool,
                    rerank_input_cap=overrides["rerank_input_cap"],
                    final_top_k=top_k,
                    recall_at_k=recall,
                    mrr=mrr,
                    mean_context_tokens=_mean_context_tokens(run.traces),
                    latency_p95_ms=_latency_p95(run.traces),
                    n_items=n_items,
                    run_config_hash=run.report.run_config_hash if run.report is not None else None,
                    out_dir=repo_relative(cell_dir),
                )
            )
            for note in run.notes:
                if note not in notes:
                    notes.append(note)
    if len(golden_hashes) != 1:
        raise SweepUsageError("the cells did not all run on the same dev golden file")

    selection = choose_configuration(cells, noise)
    proposed = _proposed_params(selection, params_path)
    live = bool(base_url)
    if not live:
        notes.append("Fixture run: the params file was not touched (D-12).")

    result = SweepResult(
        mode="live" if live else "fixture",
        run_config_name=str(config_payload.get("name", "")),
        run_config_sha256=_canonical_sha(config_payload),
        golden_sha256=next(iter(golden_hashes)),
        grid_sha256=_canonical_sha({"pools": list(grid.pools), "top_ks": list(grid.top_ks)}),
        grid=grid,
        noise=NoiseRecord(floor=noise.floor, k=noise.k, spread=0.0, band=selection.noise_band),
        cells=cells,
        selection=selection,
        proposed_params=proposed.model_dump(mode="json"),
        notes=notes,
    )
    if write_params:
        write_config_atomically(Path(params_path), proposed)
        result = result.model_copy(update={"params_written": True, "params_path": str(params_path)})

    _write_text(
        out_dir / RESULT_NAME, json.dumps(result.model_dump(mode="json"), sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    )
    _write_text(out_dir / REPORT_NAME, render_markdown(result))
    return result


def _int_list(text: str, flag: str) -> tuple[int, ...]:
    try:
        return tuple(int(part) for part in text.split(",") if part.strip())
    except ValueError as exc:
        raise SweepUsageError(f"{flag} must be a comma-separated list of integers") from exc


def _retrieval(args: argparse.Namespace) -> int:
    try:
        if args.write_params and not args.base_url:
            raise SweepUsageError(
                "--write-params needs a live --base-url: a fixture run can never replace the committed retrieval params"
            )
        try:
            grid = SweepGrid(
                pools=_int_list(args.pools, "--pools") if args.pools else DEFAULT_POOLS,
                top_ks=_int_list(args.top_ks, "--top-ks") if args.top_ks else DEFAULT_TOP_KS,
            )
        except ValidationError as exc:
            raise SweepUsageError(f"invalid grid: {exc}") from exc
        result = run_retrieval_sweep(
            resolve_cli_path(args.run_config),
            grid,
            resolve_cli_path(args.out),
            base_url=args.base_url,
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
    selection = result.selection
    if selection is not None:
        picked = selection.chosen
        print(
            f"[Retrieval Sweep] {result.mode}: {len(result.cells)} cells, chosen pool {picked.candidate_pool_size} "
            f"cap {picked.rerank_input_cap} top-k {picked.final_top_k} "
            f"(recall {picked.recall_at_k:.3f}, mrr {picked.mrr:.3f}, band {selection.noise_band:.3f}); "
            f"params written: {'yes' if result.params_written else 'no'}"
        )
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.sweep", description="myRAG eval sweeps")
    commands = parser.add_subparsers(dest="command", required=True)
    retrieval = commands.add_parser("retrieval", help="sweep candidate pool size and final top-k on the dev split")
    retrieval.add_argument("--run-config", required=True, type=Path)
    retrieval.add_argument("--out", required=True, type=Path)
    retrieval.add_argument("--golden", type=Path, default=DEFAULT_GOLDEN)
    retrieval.add_argument("--base-url", default=None)
    retrieval.add_argument("--fixture-mode", choices=("prechunked", "ingest"), default=None)
    retrieval.add_argument("--write-params", action="store_true")
    retrieval.add_argument("--pools", default=None, help="comma-separated candidate pool sizes (default 25,50,75,100)")
    retrieval.add_argument("--top-ks", default=None, help="comma-separated final top-k values (default 5,8,10,15,20)")
    retrieval.set_defaults(handler=_retrieval)
    from rag_eval.sweep.chunking import register as register_chunking

    register_chunking(commands)
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
