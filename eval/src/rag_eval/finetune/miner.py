"""python -m rag_eval.finetune mine: hard negatives for every train and dev pair of a bundle (FT-06; D-07e, D-10..D-13).

Inputs: chunks.jsonl, the kept synthetic queries (queries.kept.jsonl; RawSyntheticQuery rows from `filter`, FinetunePair
rows accepted too), pairs.mined.jsonl (FinetunePair rows from `import-mined`) and, for the default `vectors` miner, the
production vectors written by `npm run rag:finetune -- export-vectors` and `embed-queries` (06.1-10 layout, one file set per
tenant). Every input whose hash the manifest records must still match it.

Mining runs per tenant over that tenant's chunks only, and per split: train pairs draw negatives from train-split
documents only, dev pairs from train and dev; test pairs are not mined (the evaluator searches the full tenant corpus).
For one dataset (tenant, split) the selection mirrors sentence_transformers.util.mine_hard_negatives: the top
range_max + max_positives chunks by cosine, the query's positives removed (every positive of an identical anchor), then
absolute_margin, relative_margin (drop s > p - |p| * relative_margin, p the lowest positive score of the anchor),
max_score and min_score, then ranks [range_min, range_max) of the survivors. The D-12 guards follow: no chunk of the
positive's document within ±neighbour_window chunk_index, none with the positive's content hash, no positive of the query
or of its near-duplicate queries (character 3-gram Jaccard >= filters.near_dup_jaccard, over every kept query of the
tenant), and no second chunk with a content hash already taken. num_negatives are then taken by sampling_strategy: `top`,
or `random` seeded per pair. Expert negatives of mined pairs come first and the miner only tops up.

`--miner st` delegates the selection to mine_hard_negatives (labeled-list output, so a query with fewer survivors keeps
them) once per tenant and split corpus, over-fetching num_negatives x 3 and then the whole window, and applies the same
guards and sampling afterwards.

`--round-trip-k K` (off by default, D-07e) drops train and dev pairs whose positive is not in the production model's
top K over the tenant's chunks and counts them as round_trip_miss.

False-negative audit (D-12): a seeded sample of fn_audit_sample mined negatives is judged with the 06.1-07 answerability
judge under --budget-usd; the Clopper-Pearson 95% upper bound of the answerable share must be <= fn_audit_max_upper, else
the command exits 6 and writes only mining-report.json. `--fixture --skip-audit` records the audit as skipped.

Outputs: train_ntuple.jsonl (train pairs with num_negatives negatives), train_pairs.jsonl (the other train pairs),
dev.jsonl, mining-report.json (MiningReport). Stdout, stderr and the report carry ids, counts and codes only (D-31).
"""

import argparse
import inspect
import json
import math
import random
import sys
import tempfile
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO

import numpy as np
from pydantic import ValidationError
from rag_sidecar.contracts.finetune import (
    DatasetManifest,
    ExportedChunk,
    FinetuneConfig,
    FinetuneNegative,
    FinetunePair,
    FinetuneSplit,
    FnAudit,
    MiningParams,
    MiningReport,
)

from rag_eval.bounds import upper_bound
from rag_eval.finetune import bundle, vectors_io
from rag_eval.finetune.budget import Budget, estimate_tokens, prices_known
from rag_eval.finetune.config import load_finetune_config
from rag_eval.finetune.encoders import (
    Encoder,
    EncoderUnavailable,
    MissingVector,
    StoredVectorsEncoder,
    TextItem,
    load_sentence_transformer,
)
from rag_eval.finetune.filters import KEPT_FILE, TEST_KEPT_FILE
from rag_eval.finetune.generate import RawSyntheticQuery, load_chunks
from rag_eval.finetune.llm import (
    JudgeItem,
    LLMCallFailed,
    LLMOutputInvalid,
    QueryLLM,
    Usage,
)
from rag_eval.finetune.mined import PAIRS_FILE
from rag_eval.finetune.textnorm import char_ngrams, jaccard, normalize

TRAIN_NTUPLE_FILE = "train_ntuple.jsonl"
TRAIN_PAIRS_FILE = "train_pairs.jsonl"
DEV_FILE = "dev.jsonl"
REPORT_FILE = "mining-report.json"
OUTPUT_FILES = (TRAIN_NTUPLE_FILE, TRAIN_PAIRS_FILE, DEV_FILE)
QUERY_BLOCK = 1024
OVERFETCH_FACTOR = 3
JUDGE_ITEM_OVERHEAD_CHARS = 40
JUDGE_OUTPUT_TOKENS_PER_ITEM = 20
SPLIT_ORDER: tuple[FinetuneSplit, ...] = ("train", "dev", "test")
CORPUS_SPLITS: dict[str, tuple[FinetuneSplit, ...]] = {
    "train": ("train",),
    "dev": ("train", "dev"),
}
AUDIT_HINT = "raise mining.relative_margin or mining.range_min in finetune.json and mine again"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_BUDGET = 5
EXIT_AUDIT = 6

# Every keyword mine_st passes; checked against the installed function before the first call.
ST_PARAMETERS = (
    "dataset",
    "model",
    "anchor_column_name",
    "positive_column_name",
    "corpus",
    "range_min",
    "range_max",
    "max_score",
    "min_score",
    "absolute_margin",
    "relative_margin",
    "num_negatives",
    "sampling_strategy",
    "query_prompt",
    "corpus_prompt",
    "include_positives",
    "output_format",
    "output_scores",
    "batch_size",
    "verbose",
    "cache_folder",
)


class MineRefused(Exception):
    def __init__(self, code: str, exit_code: int = EXIT_USAGE):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


@dataclass(frozen=True)
class GuardQuery:
    """A kept query of any split and file: its positive is never a negative of it or of its near duplicates."""

    tenant_key: str
    pair_id: str
    anchor: str
    positive_chunk_id: str


@dataclass
class MineResult:
    exit_code: int
    report: MiningReport | None = None
    pairs: list[FinetunePair] = field(default_factory=list)


# --- near-duplicate clusters ---------------------------------------------------------------------------------


def near_duplicate_clusters(texts: Sequence[str], *, ngram: int, threshold: float) -> list[int]:
    """Cluster id per text (the index of the cluster's first member): exact normalised duplicates, plus union-find over
    pairs whose character n-gram Jaccard is >= threshold. Candidate pairs come from a prefix-filtered inverted index, so
    the result equals the all-pairs comparison without its quadratic cost."""
    parent = list(range(len(texts)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        root_i, root_j = find(i), find(j)
        if root_i != root_j:
            parent[max(root_i, root_j)] = min(root_i, root_j)

    normalized = [normalize(text) for text in texts]
    first: dict[str, int] = {}
    for index, text in enumerate(normalized):
        if text in first:
            union(first[text], index)
        else:
            first[text] = index
    grams = [char_ngrams(text, ngram) for text in normalized]
    frequency = Counter(gram for gram_set in grams for gram in gram_set)
    postings: dict[str, list[int]] = {}
    for index, gram_set in enumerate(grams):
        if not gram_set:
            continue
        ordered = sorted(gram_set, key=lambda gram: (frequency[gram], gram))
        prefix = len(ordered) - math.ceil(threshold * len(ordered) - 1e-9) + 1
        candidates: set[int] = set()
        for gram in ordered[: max(1, prefix)]:
            candidates.update(postings.get(gram, ()))
            postings.setdefault(gram, []).append(index)
        for other in candidates:
            if jaccard(gram_set, grams[other]) >= threshold:
                union(index, other)
    return [find(i) for i in range(len(texts))]


def _guard_sets(
    queries: Sequence[GuardQuery], *, ngram: int, threshold: float
) -> dict[tuple[str, str], frozenset[str]]:
    """(tenant_key, pair_id) -> chunk ids that are a positive of that query's near-duplicate cluster (itself included)."""
    out: dict[tuple[str, str], frozenset[str]] = {}
    by_tenant: dict[str, list[GuardQuery]] = {}
    for query in queries:
        by_tenant.setdefault(query.tenant_key, []).append(query)
    for tenant_key, group in by_tenant.items():
        clusters = near_duplicate_clusters([q.anchor for q in group], ngram=ngram, threshold=threshold)
        positives: dict[int, set[str]] = {}
        for cluster, query in zip(clusters, group, strict=True):
            positives.setdefault(cluster, set()).add(query.positive_chunk_id)
        for cluster, query in zip(clusters, group, strict=True):
            out[(tenant_key, query.pair_id)] = frozenset(positives[cluster])
    return out


# --- selection shared by both miners ------------------------------------------------------------------------


def _survivors(
    scores: np.ndarray,
    positive_cols: Sequence[int],
    positive_score: float,
    max_positives: int,
    params: MiningParams,
) -> list[int]:
    """mine_hard_negatives' candidate window for one query: corpus columns in descending score order."""
    k = min(params.range_max + max_positives, scores.shape[0])
    if k <= 0:
        return []
    if k < scores.shape[0]:
        top = np.argpartition(-scores, k - 1)[:k]
        top = top[np.argsort(-scores[top], kind="stable")]
    else:
        top = np.argsort(-scores, kind="stable")
    excluded = set(positive_cols)
    kept: list[int] = []
    for col in top.tolist():
        if col in excluded:
            continue
        score = float(scores[col])
        if params.absolute_margin is not None and score + params.absolute_margin > positive_score:
            continue
        if params.relative_margin is not None and score > positive_score - abs(positive_score) * params.relative_margin:
            continue
        if params.max_score is not None and score > params.max_score:
            continue
        if params.min_score is not None and score < params.min_score:
            continue
        kept.append(col)
    return kept[params.range_min : params.range_max]


def _guarded(
    chunk: ExportedChunk,
    positive: ExportedChunk,
    blocked_ids: frozenset[str],
    window: int,
) -> bool:
    if chunk.chunk_id in blocked_ids or chunk.chunk_id == positive.chunk_id:
        return True
    if chunk.content_hash == positive.content_hash:
        return True
    return chunk.document_id == positive.document_id and abs(chunk.chunk_index - positive.chunk_index) <= window


def _finish(
    pair: FinetunePair,
    ranked: Iterable[ExportedChunk],
    *,
    positive: ExportedChunk,
    blocked_ids: frozenset[str],
    chunks_by_id: dict[str, ExportedChunk],
    params: MiningParams,
    seed: int,
) -> tuple[FinetunePair, int]:
    """Expert negatives first (cut to num_negatives), then mined ones from `ranked` after the guards. Returns the new pair
    and the number of valid candidates that were available."""
    expert = [n for n in pair.negatives if n.negative_source == "expert"][: params.num_negatives]
    need = params.num_negatives - len(expert)
    taken_ids = {n.chunk_id for n in expert}
    taken_hashes = {chunks_by_id[n.chunk_id].content_hash for n in expert if n.chunk_id in chunks_by_id}
    valid: list[ExportedChunk] = []
    for chunk in ranked:
        if chunk.chunk_id in taken_ids or chunk.content_hash in taken_hashes:
            continue
        if _guarded(chunk, positive, blocked_ids, params.neighbour_window):
            continue
        valid.append(chunk)
        taken_ids.add(chunk.chunk_id)
        taken_hashes.add(chunk.content_hash)
    if need <= 0:
        chosen: list[ExportedChunk] = []
    elif params.sampling_strategy == "top" or len(valid) <= need:
        chosen = valid[:need]
    else:
        picks = sorted(random.Random(f"{seed}:{pair.pair_id}").sample(range(len(valid)), need))
        chosen = [valid[i] for i in picks]
    negatives = expert + [FinetuneNegative(chunk_id=c.chunk_id, text=c.text, negative_source="mined") for c in chosen]
    data = pair.model_dump()
    data["negatives"] = [n.model_dump() for n in negatives]
    return FinetunePair.model_validate(data), len(valid)


@dataclass
class _Dataset:
    tenant_key: str
    split: str
    pairs: list[tuple[int, FinetunePair]]
    corpus: list[ExportedChunk]
    chunks_by_id: dict[str, ExportedChunk]

    def anchor_positives(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for _, pair in self.pairs:
            ids = out.setdefault(pair.anchor, [])
            if pair.positive_chunk_id not in ids:
                ids.append(pair.positive_chunk_id)
        return out


def _datasets(pairs: Sequence[FinetunePair], chunks: Sequence[ExportedChunk]) -> list[_Dataset]:
    by_tenant: dict[str, list[ExportedChunk]] = {}
    for chunk in chunks:
        by_tenant.setdefault(chunk.tenant_key, []).append(chunk)
    out: list[_Dataset] = []
    for split, allowed in CORPUS_SPLITS.items():
        tenants = sorted({p.tenant_key for p in pairs if p.split == split})
        for tenant_key in tenants:
            tenant_chunks = by_tenant.get(tenant_key, [])
            chunks_by_id = {c.chunk_id: c for c in tenant_chunks}
            selected = [(i, p) for i, p in enumerate(pairs) if p.tenant_key == tenant_key and p.split == split]
            for _, pair in selected:
                if pair.positive_chunk_id not in chunks_by_id:
                    raise MineRefused("unknown_chunk_ref", EXIT_FAILED)
            corpus = [c for c in tenant_chunks if c.split in allowed]
            out.append(_Dataset(tenant_key, split, selected, corpus, chunks_by_id))
    return out


def _guards_for(pairs, guard_queries, ngram, threshold):
    if guard_queries is None:
        guard_queries = [GuardQuery(p.tenant_key, p.pair_id, p.anchor, p.positive_chunk_id) for p in pairs]
    return _guard_sets(guard_queries, ngram=ngram, threshold=threshold)


def _blocked(guards, pair: FinetunePair) -> frozenset[str]:
    return guards.get((pair.tenant_key, pair.pair_id), frozenset({pair.positive_chunk_id}))


def _assemble(pairs: Sequence[FinetunePair], results: dict[int, FinetunePair]) -> list[FinetunePair]:
    return [results.get(index, pair) for index, pair in enumerate(pairs)]


# --- vectors miner --------------------------------------------------------------------------------------------


def mine_vectors(
    pairs: Sequence[FinetunePair],
    chunks: Sequence[ExportedChunk],
    encoder: Encoder | Callable[[str], Encoder],
    params: MiningParams,
    *,
    seed: int = 0,
    guard_queries: Sequence[GuardQuery] | None = None,
    near_dup_ngram: int = 3,
    near_dup_jaccard: float = 0.8,
    block_size: int = QUERY_BLOCK,
) -> list[FinetunePair]:
    """NumPy miner. `encoder` is one Encoder or a per-tenant factory (the production vectors are stored per tenant).
    Returns the pairs in input order; test pairs come back unchanged."""
    guards = _guards_for(pairs, guard_queries, near_dup_ngram, near_dup_jaccard)
    results: dict[int, FinetunePair] = {}
    encoders: dict[str, Encoder] = {}
    for dataset in _datasets(pairs, chunks):
        if not dataset.pairs:
            continue
        if dataset.tenant_key not in encoders:
            encoders[dataset.tenant_key] = (
                encoder if hasattr(encoder, "encode_queries") else encoder(dataset.tenant_key)
            )
        enc = encoders[dataset.tenant_key]
        corpus = dataset.corpus
        col_of = {c.chunk_id: col for col, c in enumerate(corpus)}
        documents = enc.encode_documents([TextItem(c.chunk_id, c.text) for c in corpus])
        anchor_positives = dataset.anchor_positives()
        max_positives = max(len(ids) for ids in anchor_positives.values())
        for start in range(0, len(dataset.pairs), block_size):
            block = dataset.pairs[start : start + block_size]
            queries = enc.encode_queries([TextItem(p.pair_id, p.anchor) for _, p in block])
            scores = queries @ documents.T if len(corpus) else np.zeros((len(block), 0), dtype=np.float32)
            for row, (index, pair) in enumerate(block):
                positive_ids = anchor_positives[pair.anchor]
                if any(pid not in col_of for pid in positive_ids):
                    raise MineRefused("positive_outside_split_corpus", EXIT_FAILED)
                positive_cols = [col_of[pid] for pid in positive_ids]
                positive_score = float(min(scores[row, col] for col in positive_cols))
                window = _survivors(scores[row], positive_cols, positive_score, max_positives, params)
                results[index], _ = _finish(
                    pair,
                    (corpus[col] for col in window),
                    positive=dataset.chunks_by_id[pair.positive_chunk_id],
                    blocked_ids=_blocked(guards, pair),
                    chunks_by_id=dataset.chunks_by_id,
                    params=params,
                    seed=seed,
                )
    return _assemble(pairs, results)


# --- sentence-transformers miner ------------------------------------------------------------------------------


def _st_function() -> Callable[..., Any]:
    try:
        from sentence_transformers.util import mine_hard_negatives
    except ImportError as exc:
        raise EncoderUnavailable("the finetune extra is not installed (uv sync --extra finetune)") from exc
    missing = [name for name in ST_PARAMETERS if name not in inspect.signature(mine_hard_negatives).parameters]
    if missing:
        raise EncoderUnavailable("sentence_transformers.util.mine_hard_negatives lacks: " + ", ".join(missing))
    return mine_hard_negatives


def _st_window(
    function: Callable[..., Any],
    model: Any,
    dataset: _Dataset,
    params: MiningParams,
    count: int,
    *,
    query_prompt: str,
    corpus_prompt: str,
    batch_size: int,
    cache_folder: str,
) -> dict[tuple[str, str], list[str]]:
    from datasets import Dataset

    rows = Dataset.from_dict(
        {
            "anchor": [p.anchor for _, p in dataset.pairs],
            "positive": [dataset.chunks_by_id[p.positive_chunk_id].text for _, p in dataset.pairs],
        }
    )
    mined = function(
        dataset=rows,
        model=model,
        anchor_column_name="anchor",
        positive_column_name="positive",
        corpus=[c.text for c in dataset.corpus],
        range_min=params.range_min,
        range_max=params.range_max,
        max_score=params.max_score,
        min_score=params.min_score,
        absolute_margin=params.absolute_margin,
        relative_margin=params.relative_margin,
        num_negatives=count,
        sampling_strategy="top",
        query_prompt=query_prompt or None,
        corpus_prompt=corpus_prompt or None,
        include_positives=False,
        output_format="labeled-list",
        output_scores=True,
        batch_size=batch_size,
        verbose=False,
        cache_folder=cache_folder,
    )
    out: dict[tuple[str, str], list[str]] = {}
    for anchor, documents in zip(mined["anchor"], mined["positive"], strict=True):
        out[(anchor, documents[0])] = list(documents[1:])
    return out


def mine_st(
    pairs: Sequence[FinetunePair],
    chunks: Sequence[ExportedChunk],
    model: Any,
    params: MiningParams,
    *,
    query_prompt: str = "",
    corpus_prompt: str = "",
    seed: int = 0,
    guard_queries: Sequence[GuardQuery] | None = None,
    near_dup_ngram: int = 3,
    near_dup_jaccard: float = 0.8,
    batch_size: int = 32,
) -> list[FinetunePair]:
    """Delegates the window to mine_hard_negatives once per tenant and split corpus (train pairs against train chunks,
    dev pairs against train and dev chunks). mine_hard_negatives is called with sampling_strategy 'top' (num_negatives x 3
    first, then the whole window when the guards leave too few; the whole window at once for random sampling), and the
    guards and the configured sampling run afterwards on the returned window, as in the vectors miner."""
    function = _st_function()
    guards = _guards_for(pairs, guard_queries, near_dup_ngram, near_dup_jaccard)
    results: dict[int, FinetunePair] = {}
    window_size = params.range_max - params.range_min
    # random sampling draws from every valid candidate of the window, so it needs the whole window at once
    first = (
        window_size
        if params.sampling_strategy == "random"
        else min(params.num_negatives * OVERFETCH_FACTOR, window_size)
    )
    for dataset in _datasets(pairs, chunks):
        if not dataset.pairs:
            continue
        by_text: dict[str, list[ExportedChunk]] = {}
        for chunk in dataset.corpus:
            by_text.setdefault(chunk.text, []).append(chunk)
        with tempfile.TemporaryDirectory(prefix="ft-mine-st-") as cache_folder:
            windows = {
                first: _st_window(
                    function,
                    model,
                    dataset,
                    params,
                    first,
                    query_prompt=query_prompt,
                    corpus_prompt=corpus_prompt,
                    batch_size=batch_size,
                    cache_folder=cache_folder,
                )
            }
            for index, pair in dataset.pairs:
                positive = dataset.chunks_by_id[pair.positive_chunk_id]
                for count in (first, window_size):
                    if count not in windows:
                        windows[count] = _st_window(
                            function,
                            model,
                            dataset,
                            params,
                            count,
                            query_prompt=query_prompt,
                            corpus_prompt=corpus_prompt,
                            batch_size=batch_size,
                            cache_folder=cache_folder,
                        )
                    texts = windows[count].get((pair.anchor, positive.text), [])
                    ranked = [chunk for text in texts for chunk in by_text.get(text, [])]
                    finished, _ = _finish(
                        pair,
                        ranked,
                        positive=positive,
                        blocked_ids=_blocked(guards, pair),
                        chunks_by_id=dataset.chunks_by_id,
                        params=params,
                        seed=seed,
                    )
                    results[index] = finished
                    if len(finished.negatives) >= params.num_negatives or len(texts) < count or count == window_size:
                        break
    return _assemble(pairs, results)


# --- round trip and false-negative audit ----------------------------------------------------------------------


def round_trip_misses(
    pairs: Sequence[FinetunePair],
    chunks: Sequence[ExportedChunk],
    encoder: Encoder,
    k: int,
    *,
    block_size: int = QUERY_BLOCK,
) -> set[str]:
    """Pair ids whose positive ranks below the top k of `chunks` (one tenant's chunks) for its query."""
    if not pairs:
        return set()
    col_of = {c.chunk_id: col for col, c in enumerate(chunks)}
    documents = encoder.encode_documents([TextItem(c.chunk_id, c.text) for c in chunks])
    misses: set[str] = set()
    for start in range(0, len(pairs), block_size):
        block = pairs[start : start + block_size]
        scores = encoder.encode_queries([TextItem(p.pair_id, p.anchor) for p in block]) @ documents.T
        for row, pair in enumerate(block):
            positive = scores[row, col_of[pair.positive_chunk_id]]
            if int(np.count_nonzero(scores[row] > positive)) >= k:
                misses.add(pair.pair_id)
    return misses


class _BudgetStop(Exception):
    pass


def _judge_batches(items: Sequence[tuple[FinetunePair, FinetuneNegative]], batch_chars: int):
    batch: list[tuple[FinetunePair, FinetuneNegative]] = []
    size = 0
    for item in items:
        length = len(item[0].anchor) + len(item[1].text) + JUDGE_ITEM_OVERHEAD_CHARS
        if batch and size + length > batch_chars:
            yield batch
            batch, size = [], 0
        batch.append(item)
        size += length
    if batch:
        yield batch


def run_fn_audit(
    pairs: Sequence[FinetunePair],
    *,
    llm: QueryLLM,
    budget: Budget,
    sample_size: int,
    max_upper: float,
    seed: int,
    prompt_version: str,
    batch_chars: int,
) -> FnAudit:
    """Judges a seeded sample of mined negatives: an answerable verdict means the negative answers the query (a false
    negative). Passes when the Clopper-Pearson 95% upper bound of that share is <= max_upper."""
    items = [(pair, negative) for pair in pairs for negative in pair.negatives if negative.negative_source == "mined"]
    if not items:
        return FnAudit(sampled=0, answerable=0, passed=True, skipped=True)
    sample = random.Random(f"{seed}:fn-audit").sample(items, min(sample_size, len(items)))
    answerable = 0
    for batch in _judge_batches(sample, batch_chars):
        estimate = Usage(
            input_tokens=sum(estimate_tokens(p.anchor + n.text, p.language) for p, n in batch)
            + estimate_tokens(" " * JUDGE_ITEM_OVERHEAD_CHARS * len(batch), "en"),
            output_tokens=JUDGE_OUTPUT_TOKENS_PER_ITEM * len(batch),
        )
        if budget.would_exceed(estimate):
            raise _BudgetStop()
        judge_items = [
            JudgeItem(ref=ref, query=p.anchor, language=p.language, chunk_text=n.text)
            for ref, (p, n) in enumerate(batch)
        ]
        try:
            result = llm.judge_answerability(judge_items, prompt_version=prompt_version)
        except LLMOutputInvalid as exc:
            budget.charge(exc.usage)
            raise
        budget.charge(result.usage)
        if len(result.verdicts) != len(batch):
            raise LLMOutputInvalid("judge_refs_mismatch")
        answerable += sum(1 for verdict in result.verdicts if verdict.answerable)
    bound = upper_bound(answerable, len(sample))
    return FnAudit(
        sampled=len(sample),
        answerable=answerable,
        upper_95=bound,
        passed=bound <= max_upper,
        skipped=False,
    )


# --- bundle IO ------------------------------------------------------------------------------------------------


def _read_rows(
    path: Path,
    chunks_by_key: dict[tuple[str, str], ExportedChunk],
    *,
    raw_allowed: bool,
) -> list[FinetunePair]:
    pairs: list[FinetunePair] = []
    if not path.is_file():
        return pairs
    for line in path.read_text(encoding="utf-8").split("\n"):
        if not line.strip():
            continue
        pair: FinetunePair | None = None
        if raw_allowed:
            try:
                raw = RawSyntheticQuery.model_validate_json(line)
            except (ValidationError, ValueError):
                raw = None
            if raw is not None:
                chunk = chunks_by_key.get((raw.tenant_key, raw.chunk_id))
                if chunk is None or chunk.document_id != raw.document_id:
                    raise MineRefused("unknown_chunk_ref", EXIT_FAILED)
                pair = FinetunePair(
                    pair_id=raw.query_id,
                    tenant_key=raw.tenant_key,
                    language=raw.language,
                    positive_language=chunk.language,
                    anchor=raw.query,
                    positive_chunk_id=chunk.chunk_id,
                    positive=chunk.text,
                    source="synthetic",
                    split=max((raw.split, chunk.split), key=SPLIT_ORDER.index),
                    weight=1,
                )
        if pair is None:
            try:
                pair = FinetunePair.model_validate_json(line)
            except (ValidationError, ValueError):
                raise MineRefused("rows_invalid", EXIT_FAILED) from None
            if (pair.tenant_key, pair.positive_chunk_id) not in chunks_by_key:
                raise MineRefused("unknown_chunk_ref", EXIT_FAILED)
        pairs.append(pair)
    return pairs


@dataclass
class _Bundle:
    manifest: DatasetManifest
    chunks: list[ExportedChunk]
    pairs: list[FinetunePair]
    guard_queries: list[GuardQuery]


def _load_bundle(run_dir: Path) -> _Bundle:
    if not (run_dir / bundle.MANIFEST_FILE).is_file() or not (run_dir / bundle.CHUNKS_FILE).is_file():
        raise MineRefused("bundle_not_found")
    try:
        manifest = bundle.read_manifest(run_dir)
    except (ValueError, OSError):
        raise MineRefused("manifest_invalid", EXIT_FAILED) from None
    for name in (bundle.CHUNKS_FILE, KEPT_FILE, TEST_KEPT_FILE, PAIRS_FILE):
        recorded = manifest.files.get(name)
        if recorded is None:
            continue
        if not (run_dir / name).is_file() or recorded != bundle.sha256_file(run_dir / name):
            raise MineRefused("bundle_modified", EXIT_FAILED)
    try:
        chunks = load_chunks(run_dir)
    except (ValueError, OSError):
        raise MineRefused("chunks_invalid", EXIT_FAILED) from None
    tenants = set(manifest.tenant_keys)
    if any(chunk.tenant_key not in tenants for chunk in chunks):
        raise MineRefused("tenant_mismatch", EXIT_FAILED)
    chunks_by_key = {(c.tenant_key, c.chunk_id): c for c in chunks}
    rows = (
        _read_rows(run_dir / KEPT_FILE, chunks_by_key, raw_allowed=True)
        + _read_rows(run_dir / TEST_KEPT_FILE, chunks_by_key, raw_allowed=True)
        + _read_rows(run_dir / PAIRS_FILE, chunks_by_key, raw_allowed=False)
    )
    seen: set[tuple[str, str]] = set()
    for pair in rows:
        key = (pair.tenant_key, pair.pair_id)
        if key in seen:
            raise MineRefused("rows_duplicate_id", EXIT_FAILED)
        seen.add(key)
    if not rows:
        raise MineRefused("no_pairs")
    guard_queries = [GuardQuery(p.tenant_key, p.pair_id, p.anchor, p.positive_chunk_id) for p in rows]
    return _Bundle(manifest, chunks, [p for p in rows if p.split != "test"], guard_queries)


def _resolve_profile(run_dir: Path, tenant_key: str, profile: str | None) -> str:
    if profile is not None:
        return profile
    profiles = vectors_io.chunk_vector_profiles(run_dir, tenant_key)
    if not profiles:
        raise MineRefused("vectors_missing: run npm run rag:finetune -- export-vectors and embed-queries")
    if len(profiles) > 1:
        raise MineRefused("profile_ambiguous: pass --profile")
    return profiles[0]


def _stored_encoders(run_dir: Path, tenants: Iterable[str], profile: str | None) -> dict[str, StoredVectorsEncoder]:
    out: dict[str, StoredVectorsEncoder] = {}
    for tenant_key in tenants:
        try:
            out[tenant_key] = StoredVectorsEncoder.from_bundle(
                run_dir, tenant_key, _resolve_profile(run_dir, tenant_key, profile)
            )
        except vectors_io.VectorFileMissing:
            raise MineRefused("vectors_missing: run npm run rag:finetune -- export-vectors and embed-queries") from None
        except vectors_io.VectorFileError as exc:
            raise MineRefused(f"vectors_invalid:{exc.code}", EXIT_FAILED) from None
    return out


def _restrict_to_stored(
    pairs: list[FinetunePair],
    chunks: list[ExportedChunk],
    stored: dict[str, StoredVectorsEncoder],
) -> tuple[list[ExportedChunk], int]:
    """Drops chunks without a stored vector from the corpus; a pair whose query or positive lacks one is refused."""
    for pair in pairs:
        encoder = stored[pair.tenant_key]
        if not encoder.has_query(pair.pair_id):
            raise MineRefused("query_vectors_incomplete: run embed-queries again", EXIT_FAILED)
        if not encoder.has_document(pair.positive_chunk_id):
            raise MineRefused("chunk_vectors_incomplete: run export-vectors again", EXIT_FAILED)
    kept = [c for c in chunks if c.tenant_key in stored and stored[c.tenant_key].has_document(c.chunk_id)]
    return kept, len(chunks) - len(kept)


def _prompts(config: FinetuneConfig, model: str) -> tuple[str, str]:
    spec = next((m for m in config.base_models if m.id == model), None) or next(
        m for m in config.base_models if m.default
    )
    return spec.query_prompt, spec.document_prompt


def _write_outputs(
    run_dir: Path,
    manifest: DatasetManifest,
    report: MiningReport,
    pairs: list[FinetunePair] | None,
) -> None:
    files = dict(manifest.files)
    for name in OUTPUT_FILES:
        files.pop(name, None)
        if pairs is None:
            (run_dir / name).unlink(missing_ok=True)
    if pairs is not None:
        n = report.params.num_negatives
        train = [p for p in pairs if p.split == "train"]
        groups = {
            TRAIN_NTUPLE_FILE: [p for p in train if len(p.negatives) >= n],
            TRAIN_PAIRS_FILE: [p for p in train if len(p.negatives) < n],
            DEV_FILE: [p for p in pairs if p.split == "dev"],
        }
        for name, rows in groups.items():
            files[name] = bundle.write_jsonl(run_dir / name, rows, FinetunePair)
    payload = json.dumps(report.model_dump(mode="json"), sort_keys=True, indent=2) + "\n"
    files[REPORT_FILE] = bundle._atomic_write(run_dir / REPORT_FILE, payload.encode("utf-8"))
    bundle.write_manifest(run_dir, manifest.model_copy(update={"files": files}))


def _print(stream: TextIO, line: str) -> None:
    print(line, file=stream)


def run_mine(
    run_dir: Path,
    *,
    miner: str = "vectors",
    model: str | None = None,
    profile: str | None = None,
    budget_usd: float | None = None,
    fixture: bool = False,
    skip_audit: bool = False,
    round_trip_k: int | None = None,
    seed: int | None = None,
    config: FinetuneConfig | None = None,
    llm: QueryLLM | None = None,
    encoder_factory: Callable[[str], Encoder] | None = None,
    st_model: Any = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> MineResult:
    """`encoder_factory` replaces the stored production vectors for the vectors miner (tests and fixture runs);
    `st_model` is a loaded SentenceTransformer for the st miner."""
    out = out or sys.stdout
    err = err or sys.stderr
    config = config or load_finetune_config()
    run_dir = Path(run_dir)
    seed = config.training.seed if seed is None else seed
    try:
        if miner not in ("vectors", "st"):
            raise MineRefused("miner_unknown")
        if miner == "vectors" and model is not None:
            raise MineRefused("model_only_for_st: --model applies to --miner st")
        if skip_audit and not fixture:
            raise MineRefused("budget_required: --skip-audit is accepted only with --fixture; pass --budget-usd")
        if not skip_audit:
            if budget_usd is None:
                raise MineRefused("budget_required: pass --budget-usd for the false-negative audit")
            if not prices_known(config.prices.judge):
                raise MineRefused("prices_unknown: set prices.judge in finetune.json to enforce --budget-usd")
            if config.mining.fn_audit_sample == 0:
                raise MineRefused("fn_audit_sample_zero: set mining.fn_audit_sample above 0")
        params = MiningParams.model_validate(
            {
                **config.mining.model_dump(),
                "round_trip_k": round_trip_k if round_trip_k is not None else config.mining.round_trip_k,
            }
        )
        loaded = _load_bundle(run_dir)
        pairs = loaded.pairs
        chunks = loaded.chunks
        tenants = sorted({p.tenant_key for p in pairs})
        stored: dict[str, StoredVectorsEncoder] = {}
        need_stored = (miner == "vectors" and encoder_factory is None) or (
            params.round_trip_k is not None and encoder_factory is None
        )
        if need_stored:
            stored = _stored_encoders(run_dir, tenants, profile)
            chunks, skipped = _restrict_to_stored(pairs, chunks, stored)
            if skipped:
                _print(
                    err,
                    f"[Finetune] mine: chunks_without_vector={skipped} (left out of the candidate corpus)",
                )

        def production(tenant_key: str) -> Encoder:
            return encoder_factory(tenant_key) if encoder_factory is not None else stored[tenant_key]

        round_trip_miss = 0
        if params.round_trip_k is not None:
            dropped: set[tuple[str, str]] = set()
            for tenant_key in tenants:
                tenant_pairs = [p for p in pairs if p.tenant_key == tenant_key]
                tenant_chunks = [c for c in chunks if c.tenant_key == tenant_key]
                dropped |= {
                    (tenant_key, pid)
                    for pid in round_trip_misses(
                        tenant_pairs,
                        tenant_chunks,
                        production(tenant_key),
                        params.round_trip_k,
                    )
                }
            round_trip_miss = len(dropped)
            pairs = [p for p in pairs if (p.tenant_key, p.pair_id) not in dropped]

        common = {
            "seed": seed,
            "guard_queries": loaded.guard_queries,
            "near_dup_ngram": config.filters.near_dup_ngram,
            "near_dup_jaccard": config.filters.near_dup_jaccard,
        }
        if miner == "vectors":
            mined = mine_vectors(pairs, chunks, production, params, **common)
        else:
            model_id = model or next(m.id for m in config.base_models if m.default)
            query_prompt, document_prompt = _prompts(config, model_id)
            st = st_model if st_model is not None else load_sentence_transformer(model_id)
            mined = mine_st(
                pairs,
                chunks,
                st,
                params,
                query_prompt=query_prompt,
                corpus_prompt=document_prompt,
                **common,
            )
    except MineRefused as exc:
        _print(err, f"[Finetune] mine refused: {exc.code}")
        return MineResult(exc.exit_code)
    except EncoderUnavailable as exc:
        _print(err, f"[Finetune] mine refused: encoder_unavailable: {exc}")
        return MineResult(EXIT_USAGE)
    except MissingVector:
        _print(err, "[Finetune] mine refused: vectors_incomplete")
        return MineResult(EXIT_FAILED)

    if skip_audit:
        audit = FnAudit(sampled=0, answerable=0, passed=True, skipped=True)
    else:
        if llm is None:
            from rag_eval.finetune.llm import AnthropicQueryLLM

            llm = AnthropicQueryLLM(config)
        meter = Budget(budget_usd, config.prices.judge)
        try:
            audit = run_fn_audit(
                mined,
                llm=llm,
                budget=meter,
                sample_size=params.fn_audit_sample,
                max_upper=params.fn_audit_max_upper,
                seed=seed,
                prompt_version=config.prompts.judge,
                batch_chars=config.generation.batch_chars,
            )
        except _BudgetStop:
            _print(
                err,
                f"[Finetune] mine stopped: budget (spent_usd={meter.spent_usd:.6f}); nothing written",
            )
            return MineResult(EXIT_BUDGET)
        except (LLMCallFailed, LLMOutputInvalid) as exc:
            code = getattr(exc, "code", "llm_call_failed")
            _print(err, f"[Finetune] mine failed: fn_audit {code}; nothing written")
            return MineResult(EXIT_FAILED)

    n = params.num_negatives
    full = sum(1 for p in mined if len(p.negatives) >= n)
    report = MiningReport(
        miner=miner,
        pairs=len(mined),
        with_full_negatives=full,
        pairs_only=len(mined) - full,
        mean_negatives=(sum(len(p.negatives) for p in mined) / len(mined)) if mined else 0.0,
        round_trip_k=params.round_trip_k,
        round_trip_miss=round_trip_miss,
        fn_audit=audit,
        params=params,
    )
    audit_note = (
        "fn_audit=skipped"
        if audit.skipped
        else f"fn_audit={'passed' if audit.passed else 'failed'} sampled={audit.sampled} answerable={audit.answerable} "
        f"upper_95={audit.upper_95:.4f} max={params.fn_audit_max_upper}"
    )
    summary = (
        f"[Finetune] mine run_id={loaded.manifest.run_id} miner={miner} tenants={len(tenants)} pairs={report.pairs} "
        f"train={sum(1 for p in mined if p.split == 'train')} dev={sum(1 for p in mined if p.split == 'dev')} "
        f"with_full_negatives={full} pairs_only={report.pairs_only} mean_negatives={report.mean_negatives:.2f} "
        f"round_trip_miss={round_trip_miss} {audit_note}"
    )
    if not audit.passed:
        _write_outputs(run_dir, loaded.manifest, report, None)
        _print(out, summary)
        _print(
            err,
            f"[Finetune] mine failed: fn_audit upper bound above the limit; {AUDIT_HINT}",
        )
        return MineResult(EXIT_AUDIT, report, mined)
    _write_outputs(run_dir, loaded.manifest, report, mined)
    _print(out, summary)
    return MineResult(EXIT_OK, report, mined)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.finetune mine")
    parser.add_argument("--bundle", required=True, type=Path, help="run directory")
    parser.add_argument("--miner", choices=("vectors", "st"), default="vectors")
    parser.add_argument(
        "--model",
        default=None,
        help="sentence-transformers model path or id (--miner st)",
    )
    parser.add_argument(
        "--profile",
        default=None,
        help="embedding profile of the stored vectors (default: the only one)",
    )
    parser.add_argument(
        "--budget-usd",
        type=float,
        default=None,
        help="limit for the false-negative audit judge",
    )
    parser.add_argument("--fixture", action="store_true", help="fixture run (permits --skip-audit)")
    parser.add_argument(
        "--skip-audit",
        action="store_true",
        help="skip the false-negative audit (only with --fixture)",
    )
    parser.add_argument(
        "--round-trip-k",
        type=int,
        default=None,
        help="drop pairs whose positive is not in the top K",
    )
    parser.add_argument("--seed", type=int, default=None, help="sampling seed (default training.seed)")
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="finetune.json (default eval/config/finetune.json)",
    )
    return parser


def main(
    argv: list[str] | None = None,
    *,
    config: FinetuneConfig | None = None,
    llm: QueryLLM | None = None,
    encoder_factory: Callable[[str], Encoder] | None = None,
    st_model: Any = None,
) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return EXIT_USAGE if exc.code else EXIT_OK
    if args.round_trip_k is not None and args.round_trip_k < 1:
        print("[Finetune] mine refused: round_trip_k must be at least 1", file=sys.stderr)
        return EXIT_USAGE
    if config is None:
        try:
            config = load_finetune_config(args.config)
        except (ValueError, OSError):
            print("[Finetune] mine refused: config_invalid", file=sys.stderr)
            return EXIT_USAGE
    return run_mine(
        args.bundle,
        miner=args.miner,
        model=args.model,
        profile=args.profile,
        budget_usd=args.budget_usd,
        fixture=args.fixture,
        skip_audit=args.skip_audit,
        round_trip_k=args.round_trip_k,
        seed=args.seed,
        config=config,
        llm=llm,
        encoder_factory=encoder_factory,
        st_model=st_model,
    ).exit_code
