"""python -m rag_eval.finetune generate: synthetic queries per chunk through a budgeted, cached LLM call (Phase 6.1 D-04..D-06).

Reads <bundle>/chunks.jsonl (an `export` run) and writes, for every chunk with at least `min_chunk_tokens` tokens,
`queries_per_chunk` queries in the chunk's language with the configured styles (keyword, question, colloquial), plus one
`cross_language` query in another registry language for a share of chunks chosen by a hash of the chunk id. Train and dev
chunks go to queries.raw.jsonl (dev queries drive the trainer's evaluator); test chunks go to queries.test.raw.jsonl and
are used only for offline evaluation (D-10, D-19).

Cost control (D-06): a real run needs --budget-usd and both generator prices in finetune.json; each batch's cost is
estimated before the call and the run stops cleanly (exit 5, stopped_reason budget) before the call that would cross the
budget. --dry-run projects tokens and cost and calls nothing. Every accepted chunk result is cached under
<bundle>/cache/generate/ keyed by sha256(content_hash|prompt_version|model), so a re-run resumes without calling the LLM
for cached chunks. Output files are rewritten from the cache on every run. Stdout, stderr and the report carry counts,
ids and codes only, never chunk or query text (D-31).
"""
import argparse
import hashlib
import json
import math
import os
import sys
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, TextIO

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.finetune import (
    ExportedChunk,
    FinetuneConfig,
    FinetuneSplit,
    LlmModelId,
    ObjectId,
    PromptVersion,
    QueryStyle,
    RunId,
    Sha256,
    TenantKey,
    UuidStr,
)
from rag_sidecar.contracts.languages import Language, complete_packs

from rag_eval.finetune import bundle
from rag_eval.finetune.budget import (
    DEFAULT_CHARS_PER_TOKEN,
    Budget,
    BudgetUnenforceable,
    estimate_tokens,
    prices_known,
    project,
)
from rag_eval.finetune.config import load_finetune_config
from rag_eval.finetune.llm import (
    AnthropicQueryLLM,
    GenerationChunk,
    GenerationRequest,
    LLMCallFailed,
    LLMOutputInvalid,
    QueryLLM,
    Usage,
    generation_system_prompt,
    render_generation_request,
)

RAW_FILE = "queries.raw.jsonl"
TEST_RAW_FILE = "queries.test.raw.jsonl"
REPORT_FILE = "generate-report.json"
CACHE_DIR = Path("cache") / "generate"
CROSS_LANGUAGE_STYLE = "cross_language"
CROSS_LANGUAGE_SALT = "ft-cross-language"
CHUNK_OVERHEAD_CHARS = 80
OUTPUT_TOKENS_PER_QUERY = 40
MAX_ITEMS_PER_BATCH = 2000

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_BUDGET = 5

DROP_REASONS = ("unknown_chunk_ref", "language", "style", "surplus")


class _Row(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class RawSyntheticQuery(_Row):
    """One generated query before filtering; `language` is the language it was requested in."""

    query_id: ObjectId
    tenant_key: TenantKey
    document_id: UuidStr
    chunk_id: ObjectId
    split: FinetuneSplit
    chunk_language: Language
    language: Language
    style: QueryStyle
    query: str = Field(min_length=1, max_length=400)
    prompt_version: PromptVersion
    model: LlmModelId


class CachedQuery(_Row):
    language: Language
    style: QueryStyle
    query: str = Field(min_length=1, max_length=400)


class CacheEntry(_Row):
    key: Sha256
    prompt_version: PromptVersion
    model: LlmModelId
    items: list[CachedQuery] = Field(min_length=1)


class GenerateReport(_Row):
    run_id: RunId
    prompt_version: PromptVersion
    model: LlmModelId
    chunks_total: int = Field(ge=0)
    eligible: dict[FinetuneSplit, int]
    skipped: dict[Literal["short"], int]
    cached_chunks: int = Field(ge=0)
    generated_chunks: int = Field(ge=0)
    missing_chunks: int = Field(ge=0)
    llm_calls: int = Field(ge=0)
    invalid_batches: int = Field(ge=0)
    queries: dict[Literal["train_dev", "test"], int]
    cross_language_queries: int = Field(ge=0)
    dropped: dict[Literal["unknown_chunk_ref", "language", "style", "surplus"], int]
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    budget_usd: float = Field(ge=0)
    spent_usd: float = Field(ge=0)
    stopped_reason: Literal["budget", "llm_error"] | None = None
    complete: bool


class GenerateRefused(Exception):
    def __init__(self, code: str, exit_code: int = EXIT_USAGE):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


@dataclass
class GenerateResult:
    exit_code: int
    report: GenerateReport | None = None
    projection: dict = field(default_factory=dict)


# --- deterministic choices -----------------------------------------------------------------------------------------


def generation_languages() -> tuple[str, ...]:
    return tuple(pack.code for pack in complete_packs())


def cross_language_target(
    chunk_id: str, chunk_language: str, share: float, languages: Sequence[str] | None = None
) -> str | None:
    """The extra language for a chunk's cross_language query, or None; seeded by the chunk id (D-04)."""
    if share <= 0:
        return None
    digest = hashlib.sha256(f"{CROSS_LANGUAGE_SALT}|{chunk_id}".encode()).digest()
    if int.from_bytes(digest[:4], "big") / 2**32 >= share:
        return None
    others = sorted(code for code in (languages or generation_languages()) if code != chunk_language)
    if not others:
        return None
    return others[int.from_bytes(digest[4:8], "big") % len(others)]


def cache_key(content_hash: str, prompt_version: str, model: str) -> str:
    return hashlib.sha256(f"{content_hash}|{prompt_version}|{model}".encode()).hexdigest()


def requested_styles(config: FinetuneConfig) -> tuple[str, ...]:
    styles = config.generation.styles
    return tuple(styles[i % len(styles)] for i in range(config.generation.queries_per_chunk))


def _query_id(chunk_id: str, index: int, item: CachedQuery) -> str:
    digest = hashlib.sha256(f"{chunk_id}|{index}|{item.style}|{item.language}|{item.query}".encode()).hexdigest()
    return f"q-{digest[:32]}"


# --- bundle --------------------------------------------------------------------------------------------------------


def load_chunks(run_dir: Path) -> list[ExportedChunk]:
    return bundle.read_jsonl(Path(run_dir) / bundle.CHUNKS_FILE, ExportedChunk)


def _checked_bundle(run_dir: Path):
    run_dir = Path(run_dir)
    if not (run_dir / bundle.MANIFEST_FILE).is_file() or not (run_dir / bundle.CHUNKS_FILE).is_file():
        raise GenerateRefused("bundle_not_found")
    try:
        manifest = bundle.read_manifest(run_dir)
    except (ValueError, OSError):
        raise GenerateRefused("manifest_invalid", EXIT_FAILED) from None
    recorded = manifest.files.get(bundle.CHUNKS_FILE)
    if recorded is not None and recorded != bundle.sha256_file(run_dir / bundle.CHUNKS_FILE):
        raise GenerateRefused("bundle_modified", EXIT_FAILED)
    try:
        chunks = load_chunks(run_dir)
    except (ValueError, OSError):
        raise GenerateRefused("chunks_invalid", EXIT_FAILED) from None
    tenants = set(manifest.tenant_keys)
    if any(chunk.tenant_key not in tenants for chunk in chunks):
        raise GenerateRefused("tenant_mismatch", EXIT_FAILED)
    return manifest, chunks


def _eligible(chunk: ExportedChunk, config: FinetuneConfig) -> bool:
    return chunk.token_count >= config.generation.min_chunk_tokens


# --- batches -------------------------------------------------------------------------------------------------------


def _max_chunks_per_batch(config: FinetuneConfig) -> int:
    return max(1, MAX_ITEMS_PER_BATCH // (config.generation.queries_per_chunk + 1))


def plan_batches(chunks: Sequence[ExportedChunk], config: FinetuneConfig) -> list[list[ExportedChunk]]:
    """Eligible chunks in file order, grouped up to batch_chars characters."""
    limit = config.generation.batch_chars
    cap = _max_chunks_per_batch(config)
    batches: list[list[ExportedChunk]] = []
    current: list[ExportedChunk] = []
    size = 0
    for chunk in chunks:
        if not _eligible(chunk, config):
            continue
        cost = len(chunk.text) + CHUNK_OVERHEAD_CHARS
        if current and (size + cost > limit or len(current) >= cap):
            batches.append(current)
            current, size = [], 0
        current.append(chunk)
        size += cost
    if current:
        batches.append(current)
    return batches


def build_request(batch: Sequence[ExportedChunk], config: FinetuneConfig) -> GenerationRequest:
    share = config.generation.cross_language_share
    return GenerationRequest(
        chunks=tuple(
            GenerationChunk(
                ref=ref,
                language=chunk.language,
                text=chunk.text,
                cross_language=cross_language_target(chunk.chunk_id, chunk.language, share),
            )
            for ref, chunk in enumerate(batch)
        ),
        styles=requested_styles(config),
        prompt_version=config.prompts.generate,
    )


def estimate_batch_usage(batch: Sequence[ExportedChunk], config: FinetuneConfig) -> Usage:
    request = build_request(batch, config)
    rendered = render_generation_request(request)
    text_chars = sum(len(chunk.text) for chunk in request.chunks)
    system = generation_system_prompt(request.prompt_version)
    input_tokens = (
        math.ceil(len(system) / DEFAULT_CHARS_PER_TOKEN)
        + math.ceil(max(0, len(rendered) - text_chars) / DEFAULT_CHARS_PER_TOKEN)
        + sum(estimate_tokens(chunk.text, chunk.language) for chunk in request.chunks)
    )
    queries = len(request.chunks) * len(request.styles) + sum(1 for chunk in request.chunks if chunk.cross_language)
    return Usage(input_tokens=input_tokens, output_tokens=queries * OUTPUT_TOKENS_PER_QUERY)


# --- cache ---------------------------------------------------------------------------------------------------------


class _Cache:
    def __init__(self, run_dir: Path, config: FinetuneConfig):
        self.dir = Path(run_dir) / CACHE_DIR
        self.prompt_version = config.prompts.generate
        self.model = config.generator_model

    def key(self, chunk: ExportedChunk) -> str:
        return cache_key(chunk.content_hash, self.prompt_version, self.model)

    def get(self, chunk: ExportedChunk) -> CacheEntry | None:
        key = self.key(chunk)
        path = self.dir / f"{key}.json"
        try:
            entry = CacheEntry.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValidationError, ValueError):
            return None
        if entry.key != key or entry.prompt_version != self.prompt_version or entry.model != self.model:
            return None
        return entry

    def put(self, chunk: ExportedChunk, items: list[CachedQuery]) -> CacheEntry:
        for directory in (self.dir.parent, self.dir):
            directory.mkdir(mode=0o700, exist_ok=True)
            os.chmod(directory, 0o700)
        entry = CacheEntry(key=self.key(chunk), prompt_version=self.prompt_version, model=self.model, items=items)
        payload = json.dumps(entry.model_dump(mode="json"), ensure_ascii=False, sort_keys=True) + "\n"
        bundle._atomic_write(self.dir / f"{entry.key}.json", payload.encode("utf-8"))
        return entry


# --- response handling ---------------------------------------------------------------------------------------------


def _accept(
    batch: Sequence[ExportedChunk], request: GenerationRequest, items, dropped: Counter
) -> dict[int, list[CachedQuery]]:
    quotas: dict[int, Counter] = {}
    for chunk in request.chunks:
        quota = Counter(request.styles)
        if chunk.cross_language:
            quota[CROSS_LANGUAGE_STYLE] = 1
        quotas[chunk.ref] = quota
    accepted: dict[int, list[CachedQuery]] = {}
    for item in items:
        if item.chunk_ref not in quotas:
            dropped["unknown_chunk_ref"] += 1
            continue
        chunk = request.chunks[item.chunk_ref]
        expected = chunk.cross_language if item.style == CROSS_LANGUAGE_STYLE else chunk.language
        if item.style not in quotas[item.chunk_ref]:
            dropped["style"] += 1
            continue
        if item.language != expected:
            dropped["language"] += 1
            continue
        if quotas[item.chunk_ref][item.style] <= 0:
            dropped["surplus"] += 1
            continue
        quotas[item.chunk_ref][item.style] -= 1
        accepted.setdefault(item.chunk_ref, []).append(
            CachedQuery(language=item.language, style=item.style, query=item.query)
        )
    return accepted


# --- run -----------------------------------------------------------------------------------------------------------


def _rows_for(chunk: ExportedChunk, entry: CacheEntry) -> list[RawSyntheticQuery]:
    return [
        RawSyntheticQuery(
            query_id=_query_id(chunk.chunk_id, index, item),
            tenant_key=chunk.tenant_key,
            document_id=chunk.document_id,
            chunk_id=chunk.chunk_id,
            split=chunk.split,
            chunk_language=chunk.language,
            language=item.language,
            style=item.style,
            query=item.query,
            prompt_version=entry.prompt_version,
            model=entry.model,
        )
        for index, item in enumerate(entry.items)
    ]


def _print(out: TextIO, line: str) -> None:
    print(line, file=out)


def run_generate(
    run_dir: Path,
    *,
    budget_usd: float | None = None,
    dry_run: bool = False,
    llm: QueryLLM | None = None,
    config: FinetuneConfig | None = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> GenerateResult:
    out = out or sys.stdout
    err = err or sys.stderr
    config = config or load_finetune_config()
    price = config.prices.generator
    run_dir = Path(run_dir)
    try:
        if not dry_run and budget_usd is None:
            raise GenerateRefused("budget_required: pass --budget-usd (or --dry-run to project the cost)")
        if not dry_run and not prices_known(price):
            raise GenerateRefused("prices_unknown: set prices.generator in finetune.json to enforce --budget-usd")
        manifest, chunks = _checked_bundle(run_dir)
    except GenerateRefused as exc:
        _print(err, f"[Finetune] generate refused: {exc.code}")
        return GenerateResult(exc.exit_code)

    cache = _Cache(run_dir, config)
    eligible = [chunk for chunk in chunks if _eligible(chunk, config)]
    entries: dict[str, CacheEntry] = {}
    for chunk in eligible:
        entry = cache.get(chunk)
        if entry is not None:
            entries[chunk.chunk_id] = entry
    cached_chunks = len(entries)
    pending = [chunk for chunk in eligible if chunk.chunk_id not in entries]
    batches = plan_batches(pending, config)

    if dry_run:
        total = Usage()
        for batch in batches:
            total = total + estimate_batch_usage(batch, config)
        projection = project(total, price)
        cost = (
            f"cost_usd={projection.cost_usd:.6f}"
            if projection.cost_usd is not None
            else "cost unknown: set prices in finetune.json"
        )
        _print(
            out,
            f"[Finetune] generate dry-run run_id={manifest.run_id} chunks={len(chunks)} eligible={len(eligible)} "
            f"cached={cached_chunks} pending={len(pending)} batches={len(batches)} "
            f"input_tokens={projection.input_tokens} output_tokens={projection.output_tokens} {cost}",
        )
        return GenerateResult(EXIT_OK, projection={"input_tokens": projection.input_tokens, "output_tokens": projection.output_tokens, "cost_usd": projection.cost_usd})

    try:
        meter = Budget(budget_usd, price)
    except (BudgetUnenforceable, ValueError) as exc:
        _print(err, f"[Finetune] generate refused: {str(exc).split(':')[0]}")
        return GenerateResult(EXIT_USAGE)
    if llm is None:
        llm = AnthropicQueryLLM(config)

    dropped: Counter = Counter({reason: 0 for reason in DROP_REASONS})
    llm_calls = invalid_batches = generated_chunks = 0
    stopped_reason: str | None = None
    exit_code = EXIT_OK
    for batch in batches:
        if meter.would_exceed(estimate_batch_usage(batch, config)):
            stopped_reason = "budget"
            exit_code = EXIT_BUDGET
            break
        request = build_request(batch, config)
        llm_calls += 1
        try:
            result = llm.submit_queries(request)
        except LLMOutputInvalid as exc:
            meter.charge(exc.usage)
            invalid_batches += 1
            _print(err, f"[Finetune] generate batch {llm_calls}: output_invalid {exc.code}")
            continue
        except LLMCallFailed as exc:
            stopped_reason = "llm_error"
            exit_code = EXIT_FAILED
            _print(err, f"[Finetune] generate stopped: {exc}")
            break
        meter.charge(result.usage)
        for ref, items in _accept(batch, request, result.batch.items, dropped).items():
            entries[batch[ref].chunk_id] = cache.put(batch[ref], items)
            generated_chunks += 1

    train_dev: list[RawSyntheticQuery] = []
    test_rows: list[RawSyntheticQuery] = []
    for chunk in eligible:
        entry = entries.get(chunk.chunk_id)
        if entry is None:
            continue
        (test_rows if chunk.split == "test" else train_dev).extend(_rows_for(chunk, entry))
    raw_sha = bundle.write_jsonl(run_dir / RAW_FILE, train_dev, RawSyntheticQuery)
    test_sha = bundle.write_jsonl(run_dir / TEST_RAW_FILE, test_rows, RawSyntheticQuery)
    files = dict(manifest.files)
    files.update({RAW_FILE: raw_sha, TEST_RAW_FILE: test_sha})
    bundle.write_manifest(run_dir, manifest.model_copy(update={"files": files}))

    split_counts = Counter(chunk.split for chunk in eligible)
    report = GenerateReport(
        run_id=manifest.run_id,
        prompt_version=config.prompts.generate,
        model=config.generator_model,
        chunks_total=len(chunks),
        eligible={split: split_counts.get(split, 0) for split in ("train", "dev", "test")},
        skipped={"short": len(chunks) - len(eligible)},
        cached_chunks=cached_chunks,
        generated_chunks=generated_chunks,
        missing_chunks=sum(1 for chunk in eligible if chunk.chunk_id not in entries),
        llm_calls=llm_calls,
        invalid_batches=invalid_batches,
        queries={"train_dev": len(train_dev), "test": len(test_rows)},
        cross_language_queries=sum(1 for row in train_dev + test_rows if row.style == CROSS_LANGUAGE_STYLE),
        dropped={reason: dropped[reason] for reason in DROP_REASONS},
        input_tokens=meter.usage.input_tokens,
        output_tokens=meter.usage.output_tokens,
        budget_usd=meter.limit_usd,
        spent_usd=meter.spent_usd,
        stopped_reason=stopped_reason,
        complete=stopped_reason is None,
    )
    payload = json.dumps(report.model_dump(mode="json"), sort_keys=True, indent=2) + "\n"
    bundle._atomic_write(run_dir / REPORT_FILE, payload.encode("utf-8"))
    _print(
        out,
        f"[Finetune] generate run_id={report.run_id} chunks={report.chunks_total} "
        f"eligible_train={report.eligible['train']} eligible_dev={report.eligible['dev']} "
        f"eligible_test={report.eligible['test']} skipped_short={report.skipped['short']} "
        f"cached={report.cached_chunks} generated={report.generated_chunks} missing={report.missing_chunks} "
        f"llm_calls={report.llm_calls} invalid_batches={report.invalid_batches} "
        f"queries_train_dev={report.queries['train_dev']} queries_test={report.queries['test']} "
        f"cross_language={report.cross_language_queries} "
        + " ".join(f"dropped_{reason}={count}" for reason, count in report.dropped.items())
        + f" spent_usd={report.spent_usd:.6f} stopped={report.stopped_reason or 'none'}",
    )
    if stopped_reason == "budget":
        _print(err, "[Finetune] generate stopped: budget spent; re-run with a larger --budget-usd to resume from the cache")
    return GenerateResult(exit_code, report=report)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.finetune generate")
    parser.add_argument("--bundle", required=True, type=Path, help="run directory written by export")
    parser.add_argument("--budget-usd", type=float, default=None, help="spend limit for this run (required without --dry-run)")
    parser.add_argument("--dry-run", action="store_true", help="project tokens and cost, call nothing")
    parser.add_argument("--config", type=Path, default=None, help="finetune.json (default eval/config/finetune.json)")
    return parser


def main(argv: list[str] | None = None, *, llm: QueryLLM | None = None, config: FinetuneConfig | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return EXIT_USAGE if exc.code else EXIT_OK
    if config is None:
        try:
            config = load_finetune_config(args.config)
        except (ValueError, OSError):
            print("[Finetune] generate refused: config_invalid", file=sys.stderr)
            return EXIT_USAGE
    return run_generate(args.bundle, budget_usd=args.budget_usd, dry_run=args.dry_run, llm=llm, config=config).exit_code
