"""python -m rag_eval.finetune evaluate: offline evaluation on the fine-tune test split (FT-08; D-14, D-19).

The test queries are the bundle's test-split rows: kept synthetic queries (queries.kept.jsonl and queries.test.kept.jsonl,
a row's split being the stricter of its own and its chunk's) and mined pairs (pairs.mined.jsonl). Every input whose hash the
manifest records must still match it. Each query is scored per tenant against that tenant's whole exported corpus (all
splits) with exact cosine search, so a tenant never sees another tenant's chunks.

A query's relevant set is its positive chunk plus the tenant's chunks with the same content hash (a duplicate is the same
answer); Recall@10, MRR@10 and nDCG@10 are taken at the first relevant chunk in the top 10. Slices: overall, by query
language, by language pair (query->positive, cross-language rows only) and by source (synthetic / mined).

Three models are scored on the same corpus: the base model (`--base`, default the finetune.json default), the fine-tuned
model (`--finetuned <modeldir>`, or `vectors:<profile>` for fine-tuned vectors stored in the 06.1-10 layout) and the
production model (StoredVectorsEncoder over the bundle's stored vectors, `--profile` when more than one). When stored
production vectors miss chunks, those chunks leave the corpus for every model; a test query or positive without one is
refused. Deltas fine-tuned - production and fine-tuned - base carry paired bootstrap 95% intervals (finetune.json
evaluation.bootstrap_resamples and bootstrap_seed). The noise band is the noise.json floor (one deterministic run per arm,
so the spread term is zero, as in binding_compare). Gate: fine-tuned Recall@10 >= production + band overall, no language
slice below production - band, fine-tuned >= base overall; otherwise each failure adds its reason.

Outputs: offline-eval.json (OfflineEvalReport) and offline-eval.provenance.json (which fine-tuned model and base the report
is for, and the report's sha256, checked by `card`). `--zero-shot` scores every base model of finetune.json instead (step 0
of D-14) and writes zero-shot.json, ranked by Recall@10 then MRR@10. The manifest is not rewritten, so the dataset hash the
training kit recorded stays valid. Stdout, stderr and the reports carry ids, counts and metrics only (D-31).
"""
import argparse
import hashlib
import json
import math
import sys
from collections import defaultdict
from collections.abc import Callable, Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, TextIO

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.finetune import (
    BaseModelSpec,
    DatasetManifest,
    ExportedChunk,
    FinetuneConfig,
    FinetunePair,
    HfModelId,
    IrMetrics,
    MetricDelta,
    ModelMetricsBlock,
    OfflineEvalReport,
    OfflineModels,
    ProfileId,
    Revision,
    Sha256,
)

from rag_eval.finetune import bundle, vectors_io
from rag_eval.finetune.config import load_finetune_config
from rag_eval.finetune.encoders import (
    FINETUNE_EXTRA_HINT,
    Encoder,
    EncoderUnavailable,
    MissingVector,
    SentenceTransformerEncoder,
    StoredVectorsEncoder,
    TextItem,
)
from rag_eval.finetune.filters import KEPT_FILE, TEST_KEPT_FILE
from rag_eval.finetune.generate import load_chunks
from rag_eval.finetune.mined import PAIRS_FILE
from rag_eval.finetune.miner import MineRefused, _read_rows
from rag_eval.paired import _bootstrap_interval
from rag_eval.paths import resolve_cli_path

OFFLINE_REPORT_FILE = "offline-eval.json"
PROVENANCE_FILE = "offline-eval.provenance.json"
ZERO_SHOT_FILE = "zero-shot.json"
VECTORS_PREFIX = "vectors:"
K = 10
METRICS = ("recall_at_10", "mrr_at_10", "ndcg_at_10")
QUERY_BLOCK = 1024
TOLERANCE = 1e-9
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2

ModelName = Literal["base", "finetuned", "production"]
TenantEncoders = Callable[[str], Encoder]


class EvaluateRefused(Exception):
    def __init__(self, code: str, exit_code: int = EXIT_USAGE):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class OfflineEvalProvenance(_Strict):
    """Which models offline-eval.json scored; `card` refuses a report made for another model directory."""

    finetuned_kind: Literal["model_dir", "vectors"]
    finetuned_sha256: Sha256 | None = None
    finetuned_profile: ProfileId | None = None
    base_model: HfModelId
    base_revision: Revision
    production_profiles: dict[str, ProfileId]
    report_sha256: Sha256


class ZeroShotEntry(_Strict):
    rank: int = Field(ge=1)
    model: HfModelId
    revision: Revision
    default: bool
    metrics: ModelMetricsBlock


class ZeroShotReport(_Strict):
    k: Literal[10] = 10
    queries: int = Field(ge=0)
    ranking: list[ZeroShotEntry]
    production: ModelMetricsBlock | None = None


@dataclass
class EvaluateResult:
    exit_code: int
    report: OfflineEvalReport | None = None
    zero_shot: ZeroShotReport | None = None
    rankings: dict[str, dict[tuple[str, str], list[str]]] = field(default_factory=dict)


# --- metrics ---------------------------------------------------------------------------------------------------


def ir_metrics(ranked: Sequence[str], relevant: Collection[str], k: int = K) -> dict[str, float]:
    """Recall@k, MRR@k and nDCG@k of one query whose relevant chunks are one answer (the positive and its duplicates):
    the first relevant chunk in the top k gives recall 1, reciprocal rank and 1/log2(rank + 1); none gives zeros."""
    wanted = set(relevant)
    for position, item in enumerate(ranked[:k], start=1):
        if item in wanted:
            return {"recall_at_10": 1.0, "mrr_at_10": 1.0 / position, "ndcg_at_10": 1.0 / math.log2(position + 1)}
    return {"recall_at_10": 0.0, "mrr_at_10": 0.0, "ndcg_at_10": 0.0}


def bootstrap_interval(differences: Sequence[float], *, seed: int, resamples: int) -> tuple[float, float]:
    """Paired percentile bootstrap 95% interval of the mean difference (rag_eval.paired's resampler)."""
    if not differences:
        return 0.0, 0.0
    return _bootstrap_interval(list(differences), seed=seed, resamples=resamples)


def _mean(values: Iterable[float]) -> float:
    values = list(values)
    return min(1.0, max(0.0, math.fsum(values) / len(values))) if values else 0.0


def _aggregate(rows: Sequence[dict[str, float]]) -> IrMetrics:
    return IrMetrics(n=len(rows), **{metric: _mean(row[metric] for row in rows) for metric in METRICS})


@dataclass(frozen=True)
class _Query:
    pair: FinetunePair
    relevant: frozenset[str]

    @property
    def key(self) -> tuple[str, str]:
        return self.pair.tenant_key, self.pair.pair_id

    def slices(self) -> list[str]:
        out = ["overall", f"language:{self.pair.language}", f"source:{self.pair.source}"]
        if self.pair.language != self.pair.positive_language:
            out.append(f"pair:{self.pair.language}->{self.pair.positive_language}")
        return out


def _block(queries: Sequence[_Query], scores: Mapping[tuple[str, str], dict[str, float]]) -> ModelMetricsBlock:
    groups: dict[str, list[dict[str, float]]] = defaultdict(list)
    for query in queries:
        for slice_key in query.slices():
            groups[slice_key].append(scores[query.key])

    def part(prefix: str) -> dict[str, IrMetrics]:
        return {key[len(prefix) :]: _aggregate(rows) for key, rows in sorted(groups.items()) if key.startswith(prefix)}

    return ModelMetricsBlock(
        overall=_aggregate(groups.get("overall", [])),
        by_language=part("language:"),  # type: ignore[arg-type]
        by_pair=part("pair:"),
        by_source=part("source:"),  # type: ignore[arg-type]
    )


def _deltas(
    queries: Sequence[_Query],
    scores: Mapping[str, Mapping[tuple[str, str], dict[str, float]]],
    *,
    seed: int,
    resamples: int,
) -> list[MetricDelta]:
    members: dict[str, list[_Query]] = defaultdict(list)
    for query in queries:
        for slice_key in query.slices():
            members[slice_key].append(query)
    out: list[MetricDelta] = []
    for comparison, other in (("finetuned_vs_production", "production"), ("finetuned_vs_base", "base")):
        for slice_key in sorted(members):
            for metric in METRICS:
                differences = [
                    scores["finetuned"][q.key][metric] - scores[other][q.key][metric] for q in members[slice_key]
                ]
                low, high = bootstrap_interval(differences, seed=seed, resamples=resamples)
                clamp = lambda value: min(1.0, max(-1.0, value))
                out.append(
                    MetricDelta(
                        comparison=comparison,  # type: ignore[arg-type]
                        metric=metric,  # type: ignore[arg-type]
                        slice=slice_key,
                        delta=clamp(math.fsum(differences) / len(differences)),
                        ci_low=clamp(low),
                        ci_high=clamp(high),
                    )
                )
    return out


def gate_reasons(models: OfflineModels, band: float) -> list[str]:
    """D-19 offline promotion rule on Recall@10; an empty test split cannot pass."""
    finetuned, production, base = models.finetuned, models.production, models.base
    if finetuned.overall.n == 0:
        return ["empty_test_split"]
    reasons: list[str] = []
    if finetuned.overall.recall_at_10 < production.overall.recall_at_10 + band - TOLERANCE:
        reasons.append("below_production_overall")
    for language, metrics in finetuned.by_language.items():
        reference = production.by_language.get(language)
        if reference is not None and metrics.recall_at_10 < reference.recall_at_10 - band - TOLERANCE:
            reasons.append("language_slice_below_production")
            break
    if finetuned.overall.recall_at_10 < base.overall.recall_at_10 - TOLERANCE:
        reasons.append("below_base")
    return reasons


# --- search ----------------------------------------------------------------------------------------------------


def _top_k(query_vectors: np.ndarray, doc_vectors: np.ndarray, k: int) -> np.ndarray:
    """Exact cosine (rows are unit length): the k best chunk positions per query, ties broken by corpus order."""
    scores = query_vectors @ doc_vectors.T
    k = min(k, scores.shape[1])
    if k < scores.shape[1]:
        candidates = np.argpartition(-scores, k - 1, axis=1)[:, :k]
    else:
        candidates = np.tile(np.arange(scores.shape[1]), (scores.shape[0], 1))
    rows = []
    for row, cand in enumerate(candidates):
        order = np.lexsort((cand, -scores[row, cand]))
        rows.append(cand[order][:k])
    return np.asarray(rows, dtype=np.int64).reshape(len(rows), k)


def _rank_tenant(encoder: Encoder, chunks: Sequence[ExportedChunk], queries: Sequence[_Query]) -> dict[tuple[str, str], list[str]]:
    if not queries:
        return {}
    documents = encoder.encode_documents([TextItem(c.chunk_id, c.text) for c in chunks])
    out: dict[tuple[str, str], list[str]] = {}
    for start in range(0, len(queries), QUERY_BLOCK):
        block = queries[start : start + QUERY_BLOCK]
        vectors = encoder.encode_queries([TextItem(q.pair.pair_id, q.pair.anchor) for q in block])
        if vectors.shape[1] != documents.shape[1]:
            raise EvaluateRefused("encoder_dims_mismatch", EXIT_FAILED)
        for query, positions in zip(block, _top_k(vectors, documents, K)):
            out[query.key] = [chunks[int(p)].chunk_id for p in positions]
    return out


def _score(
    encoders: TenantEncoders,
    corpus: Mapping[str, Sequence[ExportedChunk]],
    queries: Sequence[_Query],
) -> tuple[dict[tuple[str, str], dict[str, float]], dict[tuple[str, str], list[str]]]:
    by_tenant: dict[str, list[_Query]] = defaultdict(list)
    for query in queries:
        by_tenant[query.pair.tenant_key].append(query)
    rankings: dict[tuple[str, str], list[str]] = {}
    for tenant_key in sorted(by_tenant):
        try:
            rankings.update(_rank_tenant(encoders(tenant_key), corpus[tenant_key], by_tenant[tenant_key]))
        except MissingVector:
            raise EvaluateRefused("vectors_incomplete", EXIT_FAILED) from None
    scores = {q.key: ir_metrics(rankings[q.key], q.relevant) for q in queries}
    return scores, rankings


# --- bundle ----------------------------------------------------------------------------------------------------


@dataclass
class _Loaded:
    manifest: DatasetManifest
    corpus: dict[str, list[ExportedChunk]]
    queries: list[_Query]


def _load(run_dir: Path) -> _Loaded:
    if not (run_dir / bundle.MANIFEST_FILE).is_file() or not (run_dir / bundle.CHUNKS_FILE).is_file():
        raise EvaluateRefused("bundle_not_found")
    try:
        manifest = bundle.read_manifest(run_dir)
    except (ValueError, OSError):
        raise EvaluateRefused("manifest_invalid", EXIT_FAILED) from None
    for name in (bundle.CHUNKS_FILE, KEPT_FILE, TEST_KEPT_FILE, PAIRS_FILE):
        recorded = manifest.files.get(name)
        if recorded is None:
            continue
        if not (run_dir / name).is_file() or recorded != bundle.sha256_file(run_dir / name):
            raise EvaluateRefused("bundle_modified", EXIT_FAILED)
    try:
        chunks = load_chunks(run_dir)
    except (ValueError, OSError):
        raise EvaluateRefused("chunks_invalid", EXIT_FAILED) from None
    tenants = set(manifest.tenant_keys)
    if any(chunk.tenant_key not in tenants for chunk in chunks):
        raise EvaluateRefused("tenant_mismatch", EXIT_FAILED)
    chunks_by_key = {(c.tenant_key, c.chunk_id): c for c in chunks}
    try:
        rows = (
            _read_rows(run_dir / KEPT_FILE, chunks_by_key, raw_allowed=True)
            + _read_rows(run_dir / TEST_KEPT_FILE, chunks_by_key, raw_allowed=True)
            + _read_rows(run_dir / PAIRS_FILE, chunks_by_key, raw_allowed=False)
        )
    except MineRefused as exc:
        raise EvaluateRefused(exc.code, EXIT_FAILED) from None
    seen: set[tuple[str, str]] = set()
    for pair in rows:
        if (pair.tenant_key, pair.pair_id) in seen:
            raise EvaluateRefused("rows_duplicate_id", EXIT_FAILED)
        seen.add((pair.tenant_key, pair.pair_id))
    corpus: dict[str, list[ExportedChunk]] = {tenant: [] for tenant in sorted(tenants)}
    by_hash: dict[tuple[str, str], set[str]] = defaultdict(set)
    for chunk in chunks:
        corpus[chunk.tenant_key].append(chunk)
        by_hash[(chunk.tenant_key, chunk.content_hash)].add(chunk.chunk_id)
    queries = []
    for pair in rows:
        if pair.split != "test":
            continue
        positive = chunks_by_key[(pair.tenant_key, pair.positive_chunk_id)]
        relevant = frozenset({pair.positive_chunk_id} | by_hash[(pair.tenant_key, positive.content_hash)])
        queries.append(_Query(pair, relevant))
    return _Loaded(manifest, corpus, queries)


def _resolve_profile(run_dir: Path, tenant_key: str, profile: str | None) -> str:
    if profile is not None:
        return profile
    profiles = vectors_io.chunk_vector_profiles(run_dir, tenant_key)
    if not profiles:
        raise EvaluateRefused("vectors_missing: run npm run rag:finetune -- export-vectors and embed-queries")
    if len(profiles) > 1:
        raise EvaluateRefused("profile_ambiguous: pass --profile")
    return profiles[0]


def _stored(run_dir: Path, tenant_key: str, profile: str) -> StoredVectorsEncoder:
    try:
        return StoredVectorsEncoder.from_bundle(run_dir, tenant_key, profile)
    except vectors_io.VectorFileMissing:
        raise EvaluateRefused("vectors_missing: run npm run rag:finetune -- export-vectors and embed-queries") from None
    except vectors_io.VectorFileError as exc:
        raise EvaluateRefused(f"vectors_invalid:{exc.code}", EXIT_FAILED) from None


def _restrict(loaded: _Loaded, production: Mapping[str, Encoder], err: TextIO) -> None:
    """Every model searches the chunks the production model has a vector for; test rows must have theirs."""
    for query in loaded.queries:
        encoder = production[query.pair.tenant_key]
        has_query = getattr(encoder, "has_query", None)
        has_document = getattr(encoder, "has_document", None)
        if has_query is not None and not has_query(query.pair.pair_id):
            raise EvaluateRefused("query_vectors_incomplete: run embed-queries again", EXIT_FAILED)
        if has_document is not None and not has_document(query.pair.positive_chunk_id):
            raise EvaluateRefused("chunk_vectors_incomplete: run export-vectors again", EXIT_FAILED)
    dropped = 0
    for tenant_key, chunks in loaded.corpus.items():
        has_document = getattr(production.get(tenant_key), "has_document", None)
        if has_document is None:
            continue
        kept = [c for c in chunks if has_document(c.chunk_id)]
        dropped += len(chunks) - len(kept)
        loaded.corpus[tenant_key] = kept
    if dropped:
        print(f"[Finetune] evaluate: {dropped} chunks without a stored production vector left out of the corpus", file=err)


def model_fingerprint(path: Path) -> str:
    """sha256 over the sorted relative file names and file hashes of a model directory (or of one file)."""
    path = Path(path)
    if path.is_file():
        return bundle.sha256_file(path)
    digest = hashlib.sha256()
    for item in sorted(p for p in path.rglob("*") if p.is_file()):
        digest.update(item.relative_to(path).as_posix().encode("utf-8") + b"\0")
        digest.update(bundle.sha256_file(item).encode("ascii") + b"\n")
    return digest.hexdigest()


def _write_json(path: Path, model: BaseModel) -> str:
    payload = json.dumps(model.model_dump(mode="json"), ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    return bundle._atomic_write(path, payload.encode("utf-8"))


def _noise_band(config: FinetuneConfig) -> float:
    noise = NoiseConfig.model_validate_json(resolve_cli_path(config.evaluation.noise_config).read_text(encoding="utf-8"))
    return max(noise.k * 0.0, noise.floor)


def _tenant_encoders(source: Encoder | Mapping[str, Encoder] | TenantEncoders) -> TenantEncoders:
    if isinstance(source, Mapping):
        return lambda tenant_key: source[tenant_key]
    if callable(source) and not hasattr(source, "encode_queries"):
        return source  # type: ignore[return-value]
    return lambda _tenant_key: source  # type: ignore[return-value]


def _base_spec(config: FinetuneConfig, base_id: str | None) -> BaseModelSpec:
    if base_id is None:
        return next(m for m in config.base_models if m.default)
    spec = next((m for m in config.base_models if m.id == base_id), None)
    if spec is None:
        raise EvaluateRefused("base_model_unknown: --base must be one of finetune.json base_models")
    return spec


# --- runs ------------------------------------------------------------------------------------------------------


def run_evaluate(
    run_dir: Path,
    *,
    finetuned: Encoder | Mapping[str, Encoder] | TenantEncoders,
    base: Encoder,
    production: Mapping[str, Encoder] | None = None,
    base_spec: BaseModelSpec | None = None,
    profile: str | None = None,
    finetuned_ref: str | None = None,
    config: FinetuneConfig | None = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> EvaluateResult:
    """Scores base, fine-tuned and production on the test split and writes offline-eval.json. `production` maps tenant
    keys to encoders (tests); by default the bundle's stored vectors are read. `finetuned_ref` is the --finetuned value
    recorded in the provenance file."""
    out = out or sys.stdout
    err = err or sys.stderr
    config = config or load_finetune_config()
    run_dir = Path(run_dir)
    try:
        spec = base_spec or _base_spec(config, None)
        loaded = _load(run_dir)
        profiles: dict[str, str] = {}
        if production is None:
            production = {}
            for tenant_key in loaded.manifest.tenant_keys:
                profiles[tenant_key] = _resolve_profile(run_dir, tenant_key, profile)
                production[tenant_key] = _stored(run_dir, tenant_key, profiles[tenant_key])
        _restrict(loaded, production, err)
        band = _noise_band(config)
        scores: dict[str, dict[tuple[str, str], dict[str, float]]] = {}
        rankings: dict[str, dict[tuple[str, str], list[str]]] = {}
        sources: dict[str, TenantEncoders] = {
            "base": _tenant_encoders(base),
            "finetuned": _tenant_encoders(finetuned),
            "production": _tenant_encoders(production),
        }
        for name, encoders in sources.items():
            scores[name], rankings[name] = _score(encoders, loaded.corpus, loaded.queries)
        models = OfflineModels(**{name: _block(loaded.queries, scores[name]) for name in sources})
        reasons = gate_reasons(models, band)
        deltas = (
            _deltas(
                loaded.queries,
                scores,
                seed=config.evaluation.bootstrap_seed,
                resamples=config.evaluation.bootstrap_resamples,
            )
            if loaded.queries
            else []
        )
        report = OfflineEvalReport(
            models=models,
            deltas=deltas,
            noise_band=band,
            passed=not reasons,
            reasons=reasons,  # type: ignore[arg-type]
        )
    except EvaluateRefused as exc:
        print(f"[Finetune] evaluate refused: {exc.code}", file=err)
        return EvaluateResult(exc.exit_code)
    except EncoderUnavailable:
        print(f"[Finetune] evaluate refused: encoder_unavailable ({FINETUNE_EXTRA_HINT})", file=err)
        return EvaluateResult(EXIT_USAGE)

    report_sha = _write_json(run_dir / OFFLINE_REPORT_FILE, report)
    ref = finetuned_ref
    if ref is not None and ref.startswith(VECTORS_PREFIX):
        provenance = OfflineEvalProvenance(
            finetuned_kind="vectors",
            finetuned_profile=ref[len(VECTORS_PREFIX) :],
            base_model=spec.id,
            base_revision=spec.revision,
            production_profiles=profiles,
            report_sha256=report_sha,
        )
    else:
        provenance = OfflineEvalProvenance(
            finetuned_kind="model_dir",
            finetuned_sha256=model_fingerprint(Path(ref)) if ref is not None and Path(ref).exists() else None,
            base_model=spec.id,
            base_revision=spec.revision,
            production_profiles=profiles,
            report_sha256=report_sha,
        )
    _write_json(run_dir / PROVENANCE_FILE, provenance)
    fmt = lambda block: f"{block.overall.recall_at_10:.4f}"
    verdict = "PASSED" if report.passed else "FAILED (" + ", ".join(report.reasons) + ")"
    print(
        f"[Finetune] evaluate: {models.finetuned.overall.n} test queries, {len(loaded.corpus)} tenants; Recall@10 "
        f"finetuned {fmt(models.finetuned)} production {fmt(models.production)} base {fmt(models.base)}; "
        f"noise band {band:.4f}; offline gate {verdict}",
        file=out,
    )
    return EvaluateResult(EXIT_OK, report=report, rankings=rankings)


def run_zero_shot(
    run_dir: Path,
    *,
    encoder_factory: Callable[[BaseModelSpec], Encoder],
    profile: str | None = None,
    config: FinetuneConfig | None = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> EvaluateResult:
    """Step 0 of D-14: every finetune.json base model on the test split, ranked by Recall@10 then MRR@10. The production
    model is scored too when the bundle holds its stored vectors."""
    out = out or sys.stdout
    err = err or sys.stderr
    config = config or load_finetune_config()
    run_dir = Path(run_dir)
    try:
        loaded = _load(run_dir)
        production: dict[str, Encoder] | None = None
        if all(vectors_io.chunk_vector_profiles(run_dir, t) for t in loaded.manifest.tenant_keys):
            production = {
                t: _stored(run_dir, t, _resolve_profile(run_dir, t, profile)) for t in loaded.manifest.tenant_keys
            }
            _restrict(loaded, production, err)
        blocks: list[tuple[BaseModelSpec, ModelMetricsBlock]] = []
        for spec in config.base_models:
            scores, _ = _score(_tenant_encoders(encoder_factory(spec)), loaded.corpus, loaded.queries)
            blocks.append((spec, _block(loaded.queries, scores)))
        production_block = None
        if production is not None:
            scores, _ = _score(_tenant_encoders(production), loaded.corpus, loaded.queries)
            production_block = _block(loaded.queries, scores)
    except EvaluateRefused as exc:
        print(f"[Finetune] evaluate refused: {exc.code}", file=err)
        return EvaluateResult(exc.exit_code)
    except EncoderUnavailable:
        print(f"[Finetune] evaluate refused: encoder_unavailable ({FINETUNE_EXTRA_HINT})", file=err)
        return EvaluateResult(EXIT_USAGE)
    blocks.sort(key=lambda item: (-item[1].overall.recall_at_10, -item[1].overall.mrr_at_10, item[0].id))
    report = ZeroShotReport(
        queries=len(loaded.queries),
        ranking=[
            ZeroShotEntry(rank=rank, model=spec.id, revision=spec.revision, default=spec.default, metrics=block)
            for rank, (spec, block) in enumerate(blocks, start=1)
        ],
        production=production_block,
    )
    _write_json(run_dir / ZERO_SHOT_FILE, report)
    print(f"[Finetune] evaluate --zero-shot: {report.queries} test queries", file=out)
    for entry in report.ranking:
        print(
            f"  {entry.rank}. {entry.model} Recall@10 {entry.metrics.overall.recall_at_10:.4f} "
            f"MRR@10 {entry.metrics.overall.mrr_at_10:.4f}",
            file=out,
        )
    if production_block is not None:
        print(f"  production Recall@10 {production_block.overall.recall_at_10:.4f}", file=out)
    return EvaluateResult(EXIT_OK, zero_shot=report)


# --- CLI -------------------------------------------------------------------------------------------------------


def _load_hub_encoder(spec: BaseModelSpec) -> Encoder:
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise EncoderUnavailable(FINETUNE_EXTRA_HINT) from exc
    model = SentenceTransformer(spec.id, revision=spec.revision, device="cpu")
    return SentenceTransformerEncoder(model, query_prompt=spec.query_prompt, document_prompt=spec.document_prompt)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.finetune evaluate")
    parser.add_argument("--bundle", required=True, type=Path, help="run directory")
    parser.add_argument(
        "--finetuned",
        default=None,
        help="fine-tuned model directory, or vectors:<profile> for stored fine-tuned vectors",
    )
    parser.add_argument("--base", default=None, help="base model id from finetune.json (default: the default)")
    parser.add_argument("--zero-shot", action="store_true", help="score every base model instead (D-14 step 0)")
    parser.add_argument("--profile", default=None, help="profile of the stored production vectors")
    parser.add_argument("--config", type=Path, default=None, help="finetune.json (default eval/config/finetune.json)")
    return parser


def main(
    argv: list[str] | None = None,
    *,
    config: FinetuneConfig | None = None,
    encoder_factory: Callable[[str], Encoder] | None = None,
) -> int:
    """`encoder_factory` maps a base model id or the --finetuned directory to an encoder (tests and fixture runs);
    by default hub models load at their pinned revision and the fine-tuned directory with the base model's prompts."""
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return EXIT_USAGE if exc.code else EXIT_OK

    def refuse(code: str) -> int:
        print(f"[Finetune] evaluate refused: {code}", file=sys.stderr)
        return EXIT_USAGE

    if config is None:
        try:
            config = load_finetune_config(args.config)
        except (ValueError, OSError):
            return refuse("config_invalid")
    try:
        spec = _base_spec(config, args.base)
    except EvaluateRefused as exc:
        return refuse(exc.code)

    def hub(model_spec: BaseModelSpec) -> Encoder:
        return encoder_factory(model_spec.id) if encoder_factory else _load_hub_encoder(model_spec)

    if args.zero_shot:
        if args.finetuned is not None:
            return refuse("zero_shot_takes_no_finetuned: --zero-shot scores the base models only")
        return run_zero_shot(args.bundle, encoder_factory=hub, profile=args.profile, config=config).exit_code
    if args.finetuned is None:
        return refuse("finetuned_required: pass --finetuned <modeldir|vectors:<profile>> or --zero-shot")

    finetuned: Encoder | TenantEncoders
    if args.finetuned.startswith(VECTORS_PREFIX):
        ft_profile = args.finetuned[len(VECTORS_PREFIX) :]
        if not ft_profile:
            return refuse("finetuned_profile_missing")
        finetuned = lambda tenant_key: _stored(Path(args.bundle), tenant_key, ft_profile)
    else:
        model_dir = Path(args.finetuned)
        if not model_dir.is_dir():
            return refuse("finetuned_not_found: --finetuned must be a model directory")
        if encoder_factory is not None:
            finetuned = encoder_factory(str(model_dir))
        else:
            finetuned = SentenceTransformerEncoder(
                str(model_dir), query_prompt=spec.query_prompt, document_prompt=spec.document_prompt
            )
    try:
        base = hub(spec)
    except EncoderUnavailable:
        return refuse(f"encoder_unavailable ({FINETUNE_EXTRA_HINT})")
    except ValidationError:
        return refuse("base_model_invalid")
    return run_evaluate(
        args.bundle,
        finetuned=finetuned,
        base=base,
        base_spec=spec,
        profile=args.profile,
        finetuned_ref=args.finetuned,
        config=config,
    ).exit_code
