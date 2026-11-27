"""Phase 4.4 real-set comparison of the two lexical scoring modes (D-37, LEX-08).

Four arms on one eval set: the lexical leg alone and RRF fusion, each scored with ts_rank_cd and with bm25. The lexical-alone arms are
read from the output directory of eval/harness/lexical-leg-run.mts (the two search functions called directly; a zero dense leg weight
is rejected by the contract, R-13). The RRF arms are eval-route runs with the reranker off. Per arm: Recall@10, Recall@50, MRR and
doc@1 over the answerable items, overall and per language; per bm25 - ts_rank_cd pair: the mean paired difference with a seeded
bootstrap 95% interval (rag_eval.paired). The report holds metric values, counts, item ids, hashes, config hashes and tokenizer switches,
never a question, answer, chunk or token text, and is written to a git-ignored directory unless --allow-committed-out.

Usage:
  python -m rag_eval.lexical_compare --golden <private file> --out <dir> --from-reports <dir> [--lexical-leg-dir <dir>] [--k1 ..] [--b ..]
  python -m rag_eval.lexical_compare --golden <private file> --out <dir> --base-url <url> --arm rrf_bm25 [--k1 ..] [--b ..]
With --base-url one RRF arm runs through the eval route into <out>/rrf/<arm>. The deployment's own environment decides the scoring
(a live run never takes a run-config env), so the deployment must carry the arm's RAG_LEXICAL_SCORING, k1, b and RAG_RERANKER=none;
the trace's effective configuration is checked and a mismatch is refused. Then run --from-reports <out> to compute.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.golden import GoldenItem, GoldSpan

from rag_eval.golden_io import load_golden
from rag_eval.harness_runner import HarnessError, HarnessRun, golden_for_splits, run_harness
from rag_eval.matching import chunk_matches_span
from rag_eval.paired import RESAMPLES, SEED, _bootstrap_interval
from rag_eval.paths import REPO_ROOT, repo_relative, resolve_cli_path
from rag_eval.traces import load_manifest, load_traces

DEFAULT_K1 = 1.2
DEFAULT_B = 0.75
MAX_GRID = 9
TS = "ts_rank_cd"
BM25 = "bm25"
METRICS = ("recall_at_10", "recall_at_50", "mrr", "doc_at_1")
LEGS_FILE = "lexical-legs.jsonl"
LEGS_MANIFEST = "manifest.json"
RRF_DIR = "rrf"
LEGS_DIR = "lexical-legs"
JSON_NAME = "lexical-compare.json"
MARKDOWN_NAME = "lexical-compare.md"
BASE_RUN_CONFIG = "eval/config/runs/v2-default.json"
TOKENIZER_SWITCHES = ("RAG_LEXICAL_DICTIONARY", "RAG_LEXICAL_STEM_IT", "RAG_LEXICAL_QUANTITY", "RAG_IDENTIFIER_INDEX")

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2


class CompareError(ValueError):
    pass


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# ---------- arms


class ArmSpec(_Model):
    label: str
    kind: Literal["lexical", "rrf"]
    scoring: Literal["ts_rank_cd", "bm25"]
    k1: float | None = None
    b: float | None = None
    #: the lexical-leg harness label (`ts_rank_cd`, `bm25` or `bm25:k1=..,b=..`) of a lexical arm.
    leg_label: str | None = None


def _combo_suffix(k1: float, b: float) -> str:
    return f"_k1={k1:g}_b={b:g}"


def arm_grid(k1s: Sequence[float] = (DEFAULT_K1,), bs: Sequence[float] = (DEFAULT_B,)) -> list[ArmSpec]:
    """The two ts_rank_cd arms plus one bm25 arm pair per k1 x b combination (at most 9); a single default combination is unsuffixed."""
    k1_values = list(dict.fromkeys(k1s))
    b_values = list(dict.fromkeys(bs))
    if not k1_values or not b_values:
        raise CompareError("--k1 and --b need at least one value")
    if any(not math.isfinite(v) or v < 0 for v in [*k1_values, *b_values]) or any(v > 1 for v in b_values):
        raise CompareError("k1 must be finite and not negative, b from 0 to 1")
    if len(k1_values) * len(b_values) > MAX_GRID:
        raise CompareError(f"the k1 x b grid is capped at {MAX_GRID} combinations")
    single = k1_values == [DEFAULT_K1] and b_values == [DEFAULT_B]
    arms = [
        ArmSpec(label=f"lexical_{TS}", kind="lexical", scoring=TS, leg_label=TS),
        ArmSpec(label=f"rrf_{TS}", kind="rrf", scoring=TS),
    ]
    for k1 in k1_values:
        for b in b_values:
            suffix = "" if single else _combo_suffix(k1, b)
            leg = BM25 if single else f"bm25:k1={k1:g},b={b:g}"
            arms.append(ArmSpec(label=f"lexical_{BM25}{suffix}", kind="lexical", scoring=BM25, k1=k1, b=b, leg_label=leg))
            arms.append(ArmSpec(label=f"rrf_{BM25}{suffix}", kind="rrf", scoring=BM25, k1=k1, b=b))
    return arms


def arm_pairs(arms: Sequence[ArmSpec]) -> list[tuple[ArmSpec, ArmSpec]]:
    """(ts_rank_cd arm, bm25 arm) per kind and combination."""
    base = {arm.kind: arm for arm in arms if arm.scoring == TS}
    return [(base[arm.kind], arm) for arm in arms if arm.scoring == BM25]


# ---------- ranked lists


class RankedChunk(_Model):
    chunk_id: str
    document_id: str
    document_name: str | None
    content: str


def _rrf_lists(traces: Iterable[RagTrace]) -> dict[str, list[RankedChunk]]:
    lists: dict[str, list[RankedChunk]] = {}
    for trace in traces:
        if trace.item_id is None:
            continue
        ordered = sorted(trace.candidates, key=lambda candidate: candidate.rank)
        lists[trace.item_id] = [
            RankedChunk(chunk_id=c.chunk_id, document_id=c.document_id, document_name=c.document_name, content=c.content) for c in ordered
        ]
    return lists


def _leg_lists(path: Path, leg_label: str) -> dict[str, list[RankedChunk]]:
    lists: dict[str, list[RankedChunk]] = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise CompareError(f"{repo_relative(path)} line {number} is not JSON") from exc
        arms = row.get("arms") or {}
        if leg_label not in arms:
            raise CompareError(f"{repo_relative(path)} item {row.get('item_id')} has no arm {leg_label}")
        lists[str(row["item_id"])] = [RankedChunk.model_validate(hit) for hit in arms[leg_label]]
    return lists


# ---------- metrics


def _span_hit(chunk: RankedChunk, span: GoldSpan) -> bool:
    if span.document_id is not None and chunk.document_id == span.document_id:
        return chunk_matches_span(span.document, chunk.content, span)
    return chunk_matches_span(chunk.document_name or "", chunk.content, span)


def doc_at_1(ranked: Sequence[RankedChunk], item: GoldenItem) -> float:
    """1.0 when the top-ranked chunk belongs to a gold document (by document id when the span names one, else by name), else 0.0."""
    if not ranked:
        return 0.0
    top = ranked[0]
    for span in item.gold_evidence:
        if span.document_id is not None and top.document_id == span.document_id:
            return 1.0
        if (top.document_name or "").casefold() == span.document.casefold():
            return 1.0
    return 0.0


def item_scores(ranked: Sequence[RankedChunk], item: GoldenItem) -> dict[str, float]:
    spans = list(item.gold_evidence)
    if not spans:
        raise CompareError(f"answerable item {item.id} has no gold span")

    def recall(k: int) -> float:
        top = ranked[:k]
        return sum(1 for span in spans if any(_span_hit(chunk, span) for chunk in top)) / len(spans)

    first = next((rank for rank, chunk in enumerate(ranked, start=1) if any(_span_hit(chunk, span) for span in spans)), None)
    return {"recall_at_10": recall(10), "recall_at_50": recall(50), "mrr": 1 / first if first else 0.0, "doc_at_1": doc_at_1(ranked, item)}


# ---------- report


class MetricMeans(_Model):
    n: int
    recall_at_10: float | None
    recall_at_50: float | None
    mrr: float | None
    doc_at_1: float | None


class ArmResult(_Model):
    label: str
    kind: Literal["lexical", "rrf"]
    scoring: Literal["ts_rank_cd", "bm25"]
    k1: float | None
    b: float | None
    config_hash: str
    tokenizer_switches: dict[str, str]
    item_count: int
    overall: MetricMeans
    by_language: dict[str, MetricMeans]


class PairedDiff(_Model):
    n: int
    n_nonzero: int
    mean_d: float | None
    ci_low: float | None
    ci_high: float | None


class PairResult(_Model):
    kind: Literal["lexical", "rrf"]
    baseline: str
    candidate: str
    overall: dict[str, PairedDiff]
    by_language: dict[str, dict[str, PairedDiff]]


class LexicalComparison(_Model):
    schema_version: Literal[1] = 1
    eval_set_sha256: str
    dev_set_sha256: str
    item_count: int
    item_ids_sha256: str
    seed: int
    resamples: int
    arms: list[ArmResult]
    pairs: list[PairResult]
    notes: list[str] = Field(default_factory=list)


def _means(rows: list[dict[str, float]]) -> MetricMeans:
    def mean(metric: str) -> float | None:
        return math.fsum(row[metric] for row in rows) / len(rows) if rows else None

    return MetricMeans(n=len(rows), **{metric: mean(metric) for metric in METRICS})


def _paired(differences: list[float], seed: int, resamples: int) -> PairedDiff:
    if not differences:
        return PairedDiff(n=0, n_nonzero=0, mean_d=None, ci_low=None, ci_high=None)
    low, high = _bootstrap_interval(differences, seed=seed, resamples=resamples)
    return PairedDiff(n=len(differences), n_nonzero=sum(1 for d in differences if d != 0), mean_d=math.fsum(differences) / len(differences), ci_low=low, ci_high=high)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical_hash(value: Any) -> str:
    return _sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8"))


class LoadedArm:
    def __init__(self, spec: ArmSpec, lists: dict[str, list[RankedChunk]], config_hash: str, switches: dict[str, str]) -> None:
        self.spec = spec
        self.lists = lists
        self.config_hash = config_hash
        self.switches = switches


def _dev_answerable(golden: list[GoldenItem], golden_path: Path) -> tuple[list[GoldenItem], str]:
    with tempfile.TemporaryDirectory() as tmp:
        dev_path = golden_for_splits(golden_path, Path(tmp) / "golden.dev.jsonl")
        dev_hash = _sha256(dev_path.read_bytes())
        dev_ids = {item.id for item in load_golden(dev_path)}
    return [item for item in golden if item.id in dev_ids and item.answerable], dev_hash


def load_rrf_arm(spec: ArmSpec, directory: Path, dev_hash: str) -> LoadedArm:
    if not directory.is_dir():
        raise CompareError(f"arm {spec.label}: {repo_relative(directory)} does not exist")
    try:
        manifest: RunManifest = load_manifest(directory / "run.json")
        traces = load_traces(directory / "traces.jsonl")
    except (OSError, ValueError, ValidationError) as exc:
        raise CompareError(f"arm {spec.label}: the run in {repo_relative(directory)} is unreadable: {exc}") from exc
    if manifest.golden_sha256 != dev_hash:
        raise CompareError(f"arm {spec.label}: the run's golden set hash differs from the eval set given with --golden")
    if manifest.golden_filter.gate_split != "dev":
        raise CompareError(f"arm {spec.label}: the run's golden filter is not the dev split")
    verify_rrf_traces(spec, traces)
    rag_env = traces[0].effective_config.rag_env if traces else {}
    switches = {name: rag_env[name] for name in TOKENIZER_SWITCHES if name in rag_env}
    return LoadedArm(spec, _rrf_lists(traces), manifest.run_config_hash, switches)


def _expected_env(spec: ArmSpec) -> dict[str, str]:
    env = {"RAG_LEXICAL_SCORING": spec.scoring, "RAG_RERANKER": "none"}
    if spec.scoring == BM25:
        env["RAG_LEXICAL_BM25_K1"] = f"{spec.k1:g}"
        env["RAG_LEXICAL_BM25_B"] = f"{spec.b:g}"
    return env


def verify_rrf_traces(spec: ArmSpec, traces: Sequence[RagTrace]) -> None:
    """T-04.4-43: every trace of an RRF arm ran with the arm's scoring, k1, b and no reranker (absent variables read as the app defaults)."""
    if not traces:
        raise CompareError(f"arm {spec.label}: the run has no trace")
    defaults = {"RAG_LEXICAL_SCORING": TS, "RAG_LEXICAL_BM25_K1": f"{DEFAULT_K1:g}", "RAG_LEXICAL_BM25_B": f"{DEFAULT_B:g}", "RAG_RERANKER": "none"}
    for trace in traces:
        env = trace.effective_config.rag_env
        for name, wanted in _expected_env(spec).items():
            observed = env.get(name, defaults[name]).strip().lower()
            if name in ("RAG_LEXICAL_BM25_K1", "RAG_LEXICAL_BM25_B"):
                try:
                    same = float(observed) == float(wanted)
                except ValueError:
                    same = False
            else:
                same = observed == wanted
            if not same:
                raise CompareError(f"arm {spec.label}: item {trace.item_id} ran with {name}={observed}, the arm needs {wanted}")


def load_lexical_arm(spec: ArmSpec, directory: Path, eval_hash: str) -> LoadedArm:
    manifest_path = directory / LEGS_MANIFEST
    if not manifest_path.is_file() or not (directory / LEGS_FILE).is_file():
        raise CompareError(f"arm {spec.label}: {repo_relative(directory)} holds no lexical-leg run ({LEGS_FILE}, {LEGS_MANIFEST})")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("eval_set_sha256") != eval_hash:
        raise CompareError(f"arm {spec.label}: the lexical-leg run's eval-set hash differs from the eval set given with --golden")
    labels = {arm.get("label") for arm in manifest.get("arms") or []}
    if spec.leg_label not in labels:
        raise CompareError(f"arm {spec.label}: the lexical-leg run has no arm {spec.leg_label}")
    options = manifest.get("lexical_options") or {}
    switches = {key: json.dumps(value) for key, value in sorted(options.items())}
    config_hash = _canonical_hash({"arm": spec.leg_label, "profile_id": manifest.get("profile_id"), "limit": manifest.get("limit"), "lexical_options": options})
    return LoadedArm(spec, _leg_lists(directory / LEGS_FILE, spec.leg_label or ""), config_hash, switches)


def build_comparison(
    golden: list[GoldenItem],
    arms: Sequence[LoadedArm],
    *,
    eval_hash: str,
    dev_hash: str,
    seed: int = SEED,
    resamples: int = RESAMPLES,
) -> LexicalComparison:
    items = sorted(golden, key=lambda item: item.id)
    if not items:
        raise CompareError("the eval set has no answerable dev item")
    scores: dict[str, dict[str, dict[str, float]]] = {}
    for arm in arms:
        per_item: dict[str, dict[str, float]] = {}
        for item in items:
            ranked = arm.lists.get(item.id)
            if ranked is None:
                raise CompareError(f"arm {arm.spec.label} has no result for item {item.id}")
            per_item[item.id] = item_scores(ranked, item)
        scores[arm.spec.label] = per_item
    languages = sorted({item.language for item in items})
    arm_results = [
        ArmResult(
            label=arm.spec.label,
            kind=arm.spec.kind,
            scoring=arm.spec.scoring,
            k1=arm.spec.k1,
            b=arm.spec.b,
            config_hash=arm.config_hash,
            tokenizer_switches=arm.switches,
            item_count=len(items),
            overall=_means([scores[arm.spec.label][item.id] for item in items]),
            by_language={lang: _means([scores[arm.spec.label][item.id] for item in items if item.language == lang]) for lang in languages},
        )
        for arm in arms
    ]
    by_label = {arm.spec.label: arm.spec for arm in arms}
    pairs: list[PairResult] = []
    for baseline, candidate in arm_pairs(list(by_label.values())):

        def diffs(members: list[GoldenItem], metric: str) -> list[float]:
            return [scores[candidate.label][i.id][metric] - scores[baseline.label][i.id][metric] for i in members]

        pairs.append(
            PairResult(
                kind=candidate.kind,
                baseline=baseline.label,
                candidate=candidate.label,
                overall={metric: _paired(diffs(items, metric), seed, resamples) for metric in METRICS},
                by_language={
                    lang: {metric: _paired(diffs([i for i in items if i.language == lang], metric), seed, resamples) for metric in METRICS}
                    for lang in languages
                },
            )
        )
    return LexicalComparison(
        eval_set_sha256=eval_hash,
        dev_set_sha256=dev_hash,
        item_count=len(items),
        item_ids_sha256=_sha256("\n".join(item.id for item in items).encode("utf-8")),
        seed=seed,
        resamples=resamples,
        arms=arm_results,
        pairs=pairs,
        notes=[
            "Answerable dev items only; a span counts as hit when a chunk of its document contains its normalized quote (rag_eval.matching).",
            "Lexical-alone arms come from eval/harness/lexical-leg-run.mts (search-function level); RRF arms are eval-route runs with RAG_RERANKER=none.",
            "Paired differences are bm25 minus ts_rank_cd per item with a seeded bootstrap 95% interval (rag_eval.paired._bootstrap_interval).",
        ],
    )


def _fmt(value: float | None) -> str:
    return "—" if value is None else f"{value:.4f}"


def render_markdown(report: LexicalComparison) -> str:
    lines = [
        "# Lexical scoring comparison (Phase 4.4, D-37)",
        "",
        f"Eval set `{report.eval_set_sha256[:12]}`, {report.item_count} answerable dev item(s), seed {report.seed}, {report.resamples} resamples.",
        "",
        "| Arm | Kind | Scoring | k1 | b | Recall@10 | Recall@50 | MRR | doc@1 | Config hash |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for arm in report.arms:
        o = arm.overall
        lines.append(
            f"| {arm.label} | {arm.kind} | {arm.scoring} | {_fmt(arm.k1)} | {_fmt(arm.b)} | {_fmt(o.recall_at_10)} | {_fmt(o.recall_at_50)} | "
            f"{_fmt(o.mrr)} | {_fmt(o.doc_at_1)} | `{arm.config_hash[:12]}` |"
        )
    for pair in report.pairs:
        lines += ["", f"## {pair.candidate} - {pair.baseline}", "", "| Slice | Metric | n | mean d | 95% interval |", "| --- | --- | --- | --- | --- |"]
        slices = [("overall", pair.overall), *((f"language:{lang}", stats) for lang, stats in sorted(pair.by_language.items()))]
        for name, stats in slices:
            for metric in METRICS:
                s = stats[metric]
                lines.append(f"| {name} | {metric} | {s.n} | {_fmt(s.mean_d)} | [{_fmt(s.ci_low)}, {_fmt(s.ci_high)}] |")
    lines += ["", *(f"> {note}" for note in report.notes), ""]
    return "\n".join(lines)


# ---------- output guard and runs


def assert_private_out(out: Path, *, allow_committed: bool, repo_root: Path = REPO_ROOT) -> None:
    """The report must land in a git-ignored directory (eval/out/, eval/reports/<run>/private/, ...) unless --allow-committed-out."""
    if allow_committed:
        return
    try:
        relative = Path(out).resolve().relative_to(repo_root.resolve())
    except ValueError:
        return
    probe = relative / JSON_NAME
    result = subprocess.run(["git", "check-ignore", "-q", "--no-index", str(probe)], cwd=repo_root, capture_output=True, check=False)
    if result.returncode != 0:
        raise CompareError(f"--out {repo_relative(out)} is not git-ignored; write under eval/out/ or eval/reports/<run>/private/, or pass --allow-committed-out")


HarnessCallable = Callable[..., HarnessRun]


def run_rrf_arm(spec: ArmSpec, *, golden: Path, out: Path, base_url: str, runner: HarnessCallable = run_harness) -> Path:
    """One RRF arm through the eval route against a deployment that carries the arm's settings; the traces are checked afterwards."""
    if spec.kind != "rrf":
        raise CompareError(f"{spec.label} is a lexical-alone arm; run eval/harness/lexical-leg-run.mts for it")
    target = Path(out) / RRF_DIR / spec.label
    run = runner(run_config=resolve_cli_path(BASE_RUN_CONFIG), golden=golden, out=target, base_url=base_url, env_overlay=_expected_env(spec))
    verify_rrf_traces(spec, run.traces)
    return target


def compare_from_reports(
    *,
    golden_path: Path,
    reports: Path,
    lexical_leg_dir: Path | None,
    arms: Sequence[ArmSpec],
    seed: int = SEED,
    resamples: int = RESAMPLES,
) -> LexicalComparison:
    golden_bytes = Path(golden_path).read_bytes()
    eval_hash = _sha256(golden_bytes)
    golden, dev_hash = _dev_answerable(load_golden(golden_path), Path(golden_path))
    legs = Path(lexical_leg_dir) if lexical_leg_dir is not None else Path(reports) / LEGS_DIR
    loaded = [
        load_lexical_arm(spec, legs, eval_hash) if spec.kind == "lexical" else load_rrf_arm(spec, Path(reports) / RRF_DIR / spec.label, dev_hash)
        for spec in arms
    ]
    return build_comparison(golden, loaded, eval_hash=eval_hash, dev_hash=dev_hash, seed=seed, resamples=resamples)


def write_report(report: LexicalComparison, out: Path) -> None:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    (out / JSON_NAME).write_text(json.dumps(report.model_dump(mode="json"), sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (out / MARKDOWN_NAME).write_text(render_markdown(report), encoding="utf-8")


def _numbers(value: str) -> list[float]:
    try:
        return [float(part) for part in value.split(",") if part.strip() != ""]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("a comma-separated list of numbers") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.lexical_compare", description="ts_rank_cd versus bm25 on a real eval set (Phase 4.4, D-37)")
    parser.add_argument("--golden", required=True, type=Path, help="the private eval set (golden JSONL)")
    parser.add_argument("--out", required=True, type=Path)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--from-reports", type=Path, help="compute from <dir>/rrf/<arm>/ and the lexical-leg directory")
    source.add_argument("--base-url", help="run one RRF arm (--arm) through the eval route of a deployment carrying the arm's settings")
    parser.add_argument("--arm", help="with --base-url: the RRF arm to run (rrf_ts_rank_cd, rrf_bm25 or a grid label)")
    parser.add_argument("--lexical-leg-dir", type=Path, help="output of eval/harness/lexical-leg-run.mts (default <from-reports>/lexical-legs)")
    parser.add_argument("--k1", type=_numbers, default=[DEFAULT_K1])
    parser.add_argument("--b", type=_numbers, default=[DEFAULT_B])
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--resamples", type=int, default=RESAMPLES)
    parser.add_argument("--allow-committed-out", action="store_true", help="write the report outside a git-ignored directory")
    args = parser.parse_args(argv)
    try:
        arms = arm_grid(args.k1, args.b)
        out = resolve_cli_path(args.out)
        assert_private_out(out, allow_committed=args.allow_committed_out)
        golden = resolve_cli_path(args.golden)
        if args.base_url:
            chosen = [arm for arm in arms if arm.label == args.arm and arm.kind == "rrf"]
            if not chosen:
                raise CompareError(f"--arm must be one of {', '.join(arm.label for arm in arms if arm.kind == 'rrf')}")
            target = run_rrf_arm(chosen[0], golden=golden, out=out, base_url=args.base_url)
            print(f"[Lexical Compare] arm {chosen[0].label}: {repo_relative(target)}")
            return EXIT_OK
        report = compare_from_reports(
            golden_path=golden,
            reports=resolve_cli_path(args.from_reports),
            lexical_leg_dir=resolve_cli_path(args.lexical_leg_dir) if args.lexical_leg_dir else None,
            arms=arms,
            seed=args.seed,
            resamples=args.resamples,
        )
    except (CompareError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_FAIL
    write_report(report, out)
    print(f"[Lexical Compare] {report.item_count} item(s), {len(report.arms)} arm(s): {repo_relative(out)}/{JSON_NAME}")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
