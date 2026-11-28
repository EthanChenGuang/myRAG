"""python -m rag_eval.finetune import-mined: bring Phase 5.1.1's expert-confirmed training pairs into a bundle (D-08..D-10).

Input: the NDJSON export of GET /api/rag/admin/feedback-loop/export?kind=training, one 5.1.1 `TrainingPair` per line
(ids only, no chunk text). A row is kept only when it validates, its tenant is in the bundle manifest, and its positive
and every hard negative exist among that tenant's bundle chunks with the same document id; text is resolved from the
bundle. Everything else is counted by reason (tenant_not_in_bundle, unknown_chunk, invalid_row).

Split (D-08, D-10): held_out rows and rows whose positive document is in this bundle's test split go to test and are
never trained; otherwise the positive document's split applies. Mined queries of one tenant are clustered by character
3-gram Jaccard >= the near-duplicate threshold (union-find) and every member takes the strictest split of its cluster
(test > dev > train); clustering runs over every checked row, so a member a filter later drops still pulls its cluster.

Kept rows pass the filters' own rule functions (shape and language, verbatim_copy, near_duplicate, golden_overlap) but
never the LLM judge, and are written to pairs.mined.jsonl as FinetunePair with source mined, weight mined_weight and the
expert hard negatives (confirmed first) as negatives with negative_source expert. A negative from a document stricter
than the pair's split is dropped (test text never enters training). The anchor is `query_masked`; 5.1.1 masks at log
time and no unmasked query is read. Stdout, stderr and mined-report.json carry counts and codes only (D-31).
"""
import argparse
import json
import sys
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TextIO

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.feedback_loop import TrainingPair
from rag_sidecar.contracts.finetune import (
    ExportedChunk,
    FinetuneConfig,
    FinetuneNegative,
    FinetunePair,
    FinetuneSplit,
)
from rag_sidecar.contracts.languages import LANGUAGE_CODES

from rag_eval.finetune import bundle, filters
from rag_eval.finetune.config import load_finetune_config
from rag_eval.finetune.decontam import GoldenIndex, load_golden_questions
from rag_eval.finetune.generate import load_chunks
from rag_eval.finetune.textnorm import char_ngrams, jaccard, normalize

PAIRS_FILE = "pairs.mined.jsonl"
REPORT_FILE = "mined-report.json"
SPLIT_ORDER: tuple[FinetuneSplit, ...] = ("train", "dev", "test")
MINED_STYLE = "question"
DROP_REASONS = (
    "invalid_row",
    "tenant_not_in_bundle",
    "unknown_chunk",
    "shape",
    "language",
    "verbatim_copy",
    "near_duplicate",
    "golden_overlap",
)

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2


class MinedNegativeCounts(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kept: int = Field(ge=0)
    dropped_split: int = Field(ge=0)


class MinedImportReport(BaseModel):
    """Counts only: no query, quote or chunk text (D-31)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    input_rows: int = Field(ge=0)
    kept: int = Field(ge=0)
    dropped: dict[str, int]
    by_split: dict[FinetuneSplit, int]
    held_out: int = Field(ge=0)
    cluster_promoted: int = Field(ge=0)
    negatives: MinedNegativeCounts
    judge: Literal["skipped"] = "skipped"


@dataclass
class MinedResult:
    exit_code: int
    report: MinedImportReport | None = None


class MinedRefused(Exception):
    def __init__(self, code: str, exit_code: int = EXIT_USAGE):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


@dataclass(frozen=True)
class _MinedQuery:
    """The attributes the filters' rule functions read from a query row."""

    query: str
    language: str
    tenant_key: str
    chunk_id: str
    style: str = MINED_STYLE


@dataclass
class _Candidate:
    pair: TrainingPair
    positive: ExportedChunk
    negatives: list[ExportedChunk]
    split: FinetuneSplit
    reason: str | None = None

    @property
    def query(self) -> _MinedQuery:
        return _MinedQuery(
            query=self.pair.query_masked,
            language=self.pair.language,
            tenant_key=self.pair.tenant_key,
            chunk_id=self.positive.chunk_id,
        )


def strictest_split(splits: Iterable[FinetuneSplit]) -> FinetuneSplit:
    """test > dev > train."""
    return max(splits, key=SPLIT_ORDER.index, default="train")


def cluster_queries(
    rows: Sequence[tuple[str, str]],
    *,
    ngram: int = filters.DEFAULT_NEAR_DUP_NGRAM,
    threshold: float = filters.DEFAULT_NEAR_DUP_JACCARD,
) -> list[int]:
    """Cluster id per (tenant_key, query) row: union-find over pairs of one tenant whose normalised character n-gram
    Jaccard is >= threshold. The id is the index of the cluster's first member."""
    parent = list(range(len(rows)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    by_tenant: dict[str, list[int]] = {}
    for index, (tenant_key, _) in enumerate(rows):
        by_tenant.setdefault(tenant_key, []).append(index)
    grams = [char_ngrams(normalize(query), ngram) for _, query in rows]
    for indices in by_tenant.values():
        for position, i in enumerate(indices):
            for j in indices[position + 1 :]:
                if grams[i] and grams[j] and jaccard(grams[i], grams[j]) >= threshold:
                    root_i, root_j = find(i), find(j)
                    if root_i != root_j:
                        parent[max(root_i, root_j)] = min(root_i, root_j)
    return [find(i) for i in range(len(rows))]


def _read_rows(path: Path) -> tuple[int, list[TrainingPair | None]]:
    rows: list[TrainingPair | None] = []
    for line in Path(path).read_text(encoding="utf-8").split("\n"):
        if not line.strip():
            continue
        try:
            rows.append(TrainingPair.model_validate_json(line))
        except (ValidationError, ValueError):
            rows.append(None)
    return len(rows), rows


def _checked_bundle(run_dir: Path, input_path: Path):
    run_dir = Path(run_dir)
    if not (run_dir / bundle.MANIFEST_FILE).is_file() or not (run_dir / bundle.CHUNKS_FILE).is_file():
        raise MinedRefused("bundle_not_found")
    if not Path(input_path).is_file():
        raise MinedRefused("input_not_found")
    try:
        manifest = bundle.read_manifest(run_dir)
    except (ValueError, OSError):
        raise MinedRefused("manifest_invalid", EXIT_FAILED) from None
    recorded = manifest.files.get(bundle.CHUNKS_FILE)
    if recorded is not None and recorded != bundle.sha256_file(run_dir / bundle.CHUNKS_FILE):
        raise MinedRefused("bundle_modified", EXIT_FAILED)
    try:
        chunks = load_chunks(run_dir)
    except (ValueError, OSError):
        raise MinedRefused("chunks_invalid", EXIT_FAILED) from None
    tenants = set(manifest.tenant_keys)
    if any(chunk.tenant_key not in tenants for chunk in chunks):
        raise MinedRefused("tenant_mismatch", EXIT_FAILED)
    return manifest, chunks


def _check_rows(
    rows: Sequence[TrainingPair | None], tenants: set[str], chunks_by_key: dict[tuple[str, str], ExportedChunk]
) -> tuple[list[_Candidate], Counter]:
    dropped: Counter = Counter()
    candidates: list[_Candidate] = []
    seen_items: set[str] = set()
    for pair in rows:
        if pair is None or pair.language not in LANGUAGE_CODES or pair.review_item_id in seen_items:
            dropped["invalid_row"] += 1
            continue
        seen_items.add(pair.review_item_id)
        if pair.tenant_key not in tenants:
            dropped["tenant_not_in_bundle"] += 1
            continue
        refs = [pair.positive, *pair.hard_negatives]
        resolved = [chunks_by_key.get((pair.tenant_key, ref.chunk_id)) for ref in refs]
        if any(chunk is None or chunk.document_id != ref.document_id for chunk, ref in zip(resolved, refs, strict=True)):
            dropped["unknown_chunk"] += 1
            continue
        positive, *negative_chunks = resolved
        order = sorted(
            range(len(pair.hard_negatives)),
            key=lambda i: (not pair.hard_negatives[i].confirmed, pair.hard_negatives[i].rank, i),
        )
        split: FinetuneSplit = "test" if pair.split == "held_out" else positive.split
        candidates.append(_Candidate(pair, positive, [negative_chunks[i] for i in order], split))
    return candidates, dropped


def _apply_clusters(candidates: list[_Candidate], config: FinetuneConfig) -> int:
    clusters = cluster_queries(
        [(c.pair.tenant_key, c.pair.query_masked) for c in candidates],
        ngram=config.filters.near_dup_ngram,
        threshold=config.filters.near_dup_jaccard,
    )
    members: dict[int, list[_Candidate]] = {}
    for cluster, candidate in zip(clusters, candidates, strict=True):
        members.setdefault(cluster, []).append(candidate)
    promoted = 0
    for group in members.values():
        split = strictest_split(c.split for c in group)
        for candidate in group:
            if candidate.split != split:
                promoted += 1
                candidate.split = split
    return promoted


def _apply_filters(candidates: list[_Candidate], golden: GoldenIndex, config: FinetuneConfig) -> None:
    rules = config.filters
    for candidate in candidates:
        candidate.reason = filters.rule_reason(candidate.query, candidate.positive.text, rules)
    for test in (False, True):
        survivors = [c for c in candidates if (c.split == "test") is test and c.reason is None]
        for index in filters.near_duplicates(
            [c.query for c in survivors], ngram=rules.near_dup_ngram, threshold=rules.near_dup_jaccard
        ):
            survivors[index].reason = "near_duplicate"
    for candidate in candidates:
        if candidate.reason is None:
            candidate.reason = filters.golden_reason(candidate.query, golden, rules)


def _to_pair(candidate: _Candidate, weight: int) -> tuple[FinetunePair, int]:
    limit = SPLIT_ORDER.index(candidate.split)
    negatives = [chunk for chunk in candidate.negatives if SPLIT_ORDER.index(chunk.split) <= limit]
    pair = FinetunePair(
        pair_id=f"mined:{candidate.pair.review_item_id}",
        tenant_key=candidate.pair.tenant_key,
        language=candidate.pair.language,
        positive_language=candidate.positive.language,
        anchor=candidate.pair.query_masked,
        positive_chunk_id=candidate.positive.chunk_id,
        positive=candidate.positive.text,
        negatives=[
            FinetuneNegative(chunk_id=chunk.chunk_id, text=chunk.text, negative_source="expert") for chunk in negatives
        ],
        source="mined",
        split=candidate.split,
        weight=weight,
    )
    return pair, len(candidate.negatives) - len(negatives)


def run_import_mined(
    run_dir: Path,
    input_path: Path,
    *,
    config: FinetuneConfig | None = None,
    golden: GoldenIndex | None = None,
    llm: object | None = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> MinedResult:
    """`llm` is accepted for symmetry with the other commands and is never called: mined pairs skip the judge (D-08)."""
    del llm
    out = out or sys.stdout
    err = err or sys.stderr
    config = config or load_finetune_config()
    run_dir = Path(run_dir)
    try:
        manifest, chunks = _checked_bundle(run_dir, Path(input_path))
        input_rows, rows = _read_rows(Path(input_path))
    except MinedRefused as exc:
        print(f"[Finetune] import-mined refused: {exc.code}", file=err)
        return MinedResult(exc.exit_code)
    except (OSError, UnicodeDecodeError):
        print("[Finetune] import-mined refused: input_unreadable", file=err)
        return MinedResult(EXIT_USAGE)

    if golden is None:
        golden = GoldenIndex(load_golden_questions())
    chunks_by_key = {(chunk.tenant_key, chunk.chunk_id): chunk for chunk in chunks}
    candidates, dropped = _check_rows(rows, set(manifest.tenant_keys), chunks_by_key)
    held_out = sum(1 for c in candidates if c.pair.split == "held_out")
    promoted = _apply_clusters(candidates, config)
    _apply_filters(candidates, golden, config)
    for candidate in candidates:
        if candidate.reason is not None:
            dropped[candidate.reason] += 1

    pairs: list[FinetunePair] = []
    negatives_kept = negatives_dropped = 0
    for candidate in candidates:
        if candidate.reason is None:
            pair, dropped_split = _to_pair(candidate, config.mined.mined_weight)
            pairs.append(pair)
            negatives_kept += len(pair.negatives)
            negatives_dropped += dropped_split

    by_split = {split: sum(1 for p in pairs if p.split == split) for split in SPLIT_ORDER}
    pairs_sha = bundle.write_jsonl(run_dir / PAIRS_FILE, pairs, FinetunePair)
    files = dict(manifest.files)
    files[PAIRS_FILE] = pairs_sha
    counts = {split: dict(manifest.counts.get(split, {})) for split in SPLIT_ORDER}
    for split in SPLIT_ORDER:
        counts[split]["mined"] = by_split[split]
    bundle.write_manifest(run_dir, manifest.model_copy(update={"files": files, "counts": counts}))

    report = MinedImportReport(
        input_rows=input_rows,
        kept=len(pairs),
        dropped={reason: dropped[reason] for reason in DROP_REASONS},
        by_split=by_split,
        held_out=held_out,
        cluster_promoted=promoted,
        negatives=MinedNegativeCounts(kept=negatives_kept, dropped_split=negatives_dropped),
    )
    payload = json.dumps(report.model_dump(mode="json"), sort_keys=True, indent=2) + "\n"
    bundle._atomic_write(run_dir / REPORT_FILE, payload.encode("utf-8"))
    print(
        f"[Finetune] import-mined run_id={manifest.run_id} rows={input_rows} kept={len(pairs)} "
        + " ".join(f"{split}={count}" for split, count in by_split.items())
        + f" held_out={held_out} cluster_promoted={promoted} "
        + " ".join(f"dropped_{reason}={report.dropped[reason]}" for reason in DROP_REASONS)
        + f" negatives_kept={negatives_kept} negatives_dropped_split={negatives_dropped} judge=skipped",
        file=out,
    )
    return MinedResult(EXIT_OK, report)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.finetune import-mined")
    parser.add_argument("--bundle", required=True, type=Path, help="run directory written by export")
    parser.add_argument("--input", required=True, type=Path, help="Phase 5.1.1 TrainingPair NDJSON export")
    parser.add_argument("--config", type=Path, default=None, help="finetune.json (default eval/config/finetune.json)")
    return parser


def main(argv: list[str] | None = None, *, config: FinetuneConfig | None = None, golden: GoldenIndex | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return EXIT_USAGE if exc.code else EXIT_OK
    if config is None:
        try:
            config = load_finetune_config(args.config)
        except (ValueError, OSError):
            print("[Finetune] import-mined refused: config_invalid", file=sys.stderr)
            return EXIT_USAGE
    return run_import_mined(args.bundle, args.input, config=config, golden=golden).exit_code
