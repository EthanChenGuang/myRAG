"""python -m rag_eval.finetune filter: keep only answerable, non-copied, non-duplicate, non-golden queries (Phase 6.1 D-07, D-09).

Rule filters, in order: (a) shape (length within the language's bounds) and language (the registry detector confidently
names another language than the requested one), (b) verbatim_copy, (c) near_duplicate, then golden_overlap (D-09).
Thresholds come from the `filters` block of eval/config/finetune.json.

The command reads <bundle>/queries.raw.jsonl and queries.test.raw.jsonl (written by `generate`) with the chunks of
<bundle>/chunks.jsonl, and writes queries.kept.jsonl, queries.test.kept.jsonl and filter-report.json (FilterReport). After
the rules, (d) the LLM answerability judge (D-07d) sees only the surviving (query, chunk) pairs, in batches, under the
budget meter; a verdict that is not answerable or below `judge_min_confidence` drops the query. Verdicts are cached under
<bundle>/cache/judge/ keyed by sha256(query|chunk content_hash|prompt_version|model), so a run stopped by the budget
resumes without calling the judge again for judged pairs. A stopped or incomplete run writes no kept file and no report.
(e) Round-trip consistency needs production query vectors and lives in `mine --round-trip-k` (06.1-11): the report
records round_trip: not_applied. --skip-judge is accepted only with --fixture and is recorded in the report. Stdout,
stderr and the report carry counts and codes only, never query or chunk text (D-31).
"""
import argparse
import hashlib
import json
import math
import os
import sys
from collections import Counter, defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

from pydantic import BaseModel, ConfigDict, ValidationError
from rag_sidecar.contracts.finetune import (
    DropReason,
    FilterConfig,
    FilterReport,
    FinetuneConfig,
    LanguageFilterCounts,
    LlmModelId,
    PromptVersion,
    Rate,
    Sha256,
)
from rag_sidecar.ingest.lang import detect_language_with_confidence

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
from rag_eval.finetune.decontam import GoldenIndex, load_golden_questions
from rag_eval.finetune.generate import (
    RAW_FILE,
    TEST_RAW_FILE,
    RawSyntheticQuery,
    load_chunks,
)
from rag_eval.finetune.llm import (
    AnthropicQueryLLM,
    JudgeItem,
    LLMCallFailed,
    LLMOutputInvalid,
    QueryLLM,
    Usage,
    judge_system_prompt,
    render_judge_items,
)
from rag_eval.finetune.textnorm import char_ngrams, containment, jaccard, normalize

STYLE_ORDER = ("keyword", "question", "colloquial", "cross_language")
MAX_QUERY_CHARS = 400
DEFAULT_CONTAINMENT_NGRAM = 5
DEFAULT_VERBATIM_CONTAINMENT = 0.6
DEFAULT_LCS_RATIO = 0.7
DEFAULT_NEAR_DUP_NGRAM = 3
DEFAULT_NEAR_DUP_JACCARD = 0.8


def longest_common_substring(query: str, text: str) -> int:
    """Length of the longest common substring; a sparse DP row over the query's positions (queries are <= 400 chars)."""
    if not query or not text:
        return 0
    positions: dict[str, list[int]] = defaultdict(list)
    for index, ch in enumerate(query):
        positions[ch].append(index)
    best = 0
    previous: dict[int, int] = {}
    for ch in text:
        current: dict[int, int] = {}
        for index in positions.get(ch, ()):
            length = previous.get(index - 1, 0) + 1
            current[index] = length
            best = max(best, length)
        previous = current
        if best == len(query):
            break
    return best


def verbatim_copy(
    query: str,
    chunk_text: str,
    *,
    ngram: int = DEFAULT_CONTAINMENT_NGRAM,
    containment_threshold: float = DEFAULT_VERBATIM_CONTAINMENT,
    lcs_ratio: float = DEFAULT_LCS_RATIO,
) -> bool:
    """True when the normalised query's character n-grams are mostly in the chunk, or a long substring is copied (D-07b)."""
    q = normalize(query)
    c = normalize(chunk_text)
    if not q or not c:
        return False
    if len(q) >= ngram and containment(char_ngrams(q, ngram), char_ngrams(c, ngram)) >= containment_threshold:
        return True
    return longest_common_substring(q, c) >= lcs_ratio * len(q)


def _length_bounds(language: str, config: FilterConfig) -> tuple[int, int]:
    return config.min_query_chars.get(language, 1), config.max_query_chars.get(language, MAX_QUERY_CHARS)


def shape_ok(row: RawSyntheticQuery, config: FilterConfig) -> bool:
    low, high = _length_bounds(row.language, config)
    return low <= len(row.query.strip()) <= high


def language_ok(row: RawSyntheticQuery) -> bool:
    """A query is in the wrong language only when the detector is confident about another language."""
    detection = detect_language_with_confidence(row.query)
    return not (detection.confident and detection.language is not None and detection.language != row.language)


def rule_reason(row: RawSyntheticQuery, chunk_text: str, config: FilterConfig) -> str | None:
    """The first per-query rule that drops the row (shape, language, verbatim_copy), or None."""
    if not shape_ok(row, config):
        return "shape"
    if not language_ok(row):
        return "language"
    if verbatim_copy(
        row.query,
        chunk_text,
        ngram=config.containment_ngram,
        containment_threshold=config.verbatim_containment,
        lcs_ratio=config.lcs_ratio,
    ):
        return "verbatim_copy"
    return None


def golden_reason(row: RawSyntheticQuery, golden: GoldenIndex, config: FilterConfig) -> str | None:
    return "golden_overlap" if golden.overlaps(row.query, config.golden_overlap_jaccard) else None


def _style_rank(style: str) -> int:
    return STYLE_ORDER.index(style) if style in STYLE_ORDER else len(STYLE_ORDER)


def near_duplicates(
    rows: Sequence[RawSyntheticQuery],
    *,
    ngram: int = DEFAULT_NEAR_DUP_NGRAM,
    threshold: float = DEFAULT_NEAR_DUP_JACCARD,
) -> set[int]:
    """Indices to drop (D-07c): exact normalised duplicates inside a tenant, and n-gram Jaccard >= threshold among one
    chunk's queries. Rows are visited chunk by chunk in first-seen order and, inside a chunk, by style order (keyword,
    question, colloquial, cross_language); the first of a duplicate group is kept."""
    by_chunk: dict[tuple[str, str], list[int]] = {}
    for index, row in enumerate(rows):
        by_chunk.setdefault((row.tenant_key, row.chunk_id), []).append(index)
    seen: set[tuple[str, str]] = set()
    dropped: set[int] = set()
    for indices in by_chunk.values():
        kept_grams: list[set[str]] = []
        for index in sorted(indices, key=lambda i: (_style_rank(rows[i].style), i)):
            row = rows[index]
            key = (row.tenant_key, normalize(row.query))
            if key in seen:
                dropped.add(index)
                continue
            grams = char_ngrams(key[1], ngram)
            if any(jaccard(grams, other) >= threshold for other in kept_grams):
                dropped.add(index)
                continue
            seen.add(key)
            kept_grams.append(grams)
    return dropped



# --- the filter command --------------------------------------------------------------------------------------------

KEPT_FILE = "queries.kept.jsonl"
TEST_KEPT_FILE = "queries.test.kept.jsonl"
REPORT_FILE = "filter-report.json"
CACHE_DIR = Path("cache") / "judge"
DROP_REASONS: tuple[DropReason, ...] = (
    "shape",
    "language",
    "verbatim_copy",
    "near_duplicate",
    "not_answerable",
    "low_confidence",
    "golden_overlap",
    "unknown_chunk_ref",
)
ITEM_OVERHEAD_CHARS = 80
OUTPUT_TOKENS_PER_VERDICT = 20
MAX_ITEMS_PER_BATCH = 2000

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_BUDGET = 5


class FilterRefused(Exception):
    def __init__(self, code: str, exit_code: int = EXIT_USAGE):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


class JudgeCacheEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    key: Sha256
    prompt_version: PromptVersion
    model: LlmModelId
    answerable: bool
    confidence: Rate


@dataclass
class FilterResult:
    exit_code: int
    report: FilterReport | None = None
    projection: dict = field(default_factory=dict)


@dataclass
class _Candidate:
    row: RawSyntheticQuery
    test: bool
    chunk_text: str = ""
    content_hash: str = ""
    reason: str | None = None


def judge_cache_key(query: str, content_hash: str, prompt_version: str, model: str) -> str:
    return hashlib.sha256(f"{query}|{content_hash}|{prompt_version}|{model}".encode()).hexdigest()


class _JudgeCache:
    def __init__(self, run_dir: Path, config: FinetuneConfig):
        self.dir = Path(run_dir) / CACHE_DIR
        self.prompt_version = config.prompts.judge
        self.model = config.judge_model

    def key(self, candidate: _Candidate) -> str:
        return judge_cache_key(candidate.row.query, candidate.content_hash, self.prompt_version, self.model)

    def get(self, candidate: _Candidate) -> JudgeCacheEntry | None:
        key = self.key(candidate)
        try:
            entry = JudgeCacheEntry.model_validate_json((self.dir / f"{key}.json").read_text(encoding="utf-8"))
        except (OSError, ValidationError, ValueError):
            return None
        if entry.key != key or entry.prompt_version != self.prompt_version or entry.model != self.model:
            return None
        return entry

    def put(self, candidate: _Candidate, answerable: bool, confidence: float) -> JudgeCacheEntry:
        for directory in (self.dir.parent, self.dir):
            directory.mkdir(mode=0o700, exist_ok=True)
            os.chmod(directory, 0o700)
        entry = JudgeCacheEntry(
            key=self.key(candidate),
            prompt_version=self.prompt_version,
            model=self.model,
            answerable=answerable,
            confidence=confidence,
        )
        payload = json.dumps(entry.model_dump(mode="json"), sort_keys=True) + "\n"
        bundle._atomic_write(self.dir / f"{entry.key}.json", payload.encode("utf-8"))
        return entry


def _checked_bundle(run_dir: Path):
    run_dir = Path(run_dir)
    required = (bundle.MANIFEST_FILE, bundle.CHUNKS_FILE, RAW_FILE, TEST_RAW_FILE)
    if not all((run_dir / name).is_file() for name in required):
        raise FilterRefused("bundle_not_found")
    try:
        manifest = bundle.read_manifest(run_dir)
    except (ValueError, OSError):
        raise FilterRefused("manifest_invalid", EXIT_FAILED) from None
    for name in (bundle.CHUNKS_FILE, RAW_FILE, TEST_RAW_FILE):
        recorded = manifest.files.get(name)
        if recorded is not None and recorded != bundle.sha256_file(run_dir / name):
            raise FilterRefused("bundle_modified", EXIT_FAILED)
    try:
        chunks = load_chunks(run_dir)
        raw = bundle.read_jsonl(run_dir / RAW_FILE, RawSyntheticQuery)
        test_raw = bundle.read_jsonl(run_dir / TEST_RAW_FILE, RawSyntheticQuery)
    except (ValueError, OSError):
        raise FilterRefused("queries_invalid", EXIT_FAILED) from None
    tenants = set(manifest.tenant_keys)
    if any(row.tenant_key not in tenants for row in [*chunks, *raw, *test_raw]):
        raise FilterRefused("tenant_mismatch", EXIT_FAILED)
    return manifest, chunks, raw, test_raw


def apply_rules(candidates: list[_Candidate], chunks_by_key: dict, golden: GoldenIndex, config: FilterConfig) -> None:
    """Sets `reason` on every candidate a rule drops, in the D-07 order: (a) shape/language, (b) verbatim_copy,
    (c) near_duplicate (per file), then golden_overlap (D-09). A query whose chunk is not in the bundle is
    unknown_chunk_ref."""
    for candidate in candidates:
        chunk = chunks_by_key.get((candidate.row.tenant_key, candidate.row.chunk_id))
        if chunk is None:
            candidate.reason = "unknown_chunk_ref"
            continue
        candidate.chunk_text = chunk.text
        candidate.content_hash = chunk.content_hash
        candidate.reason = rule_reason(candidate.row, chunk.text, config)
    for test in (False, True):
        survivors = [c for c in candidates if c.test is test and c.reason is None]
        for index in near_duplicates(
            [c.row for c in survivors], ngram=config.near_dup_ngram, threshold=config.near_dup_jaccard
        ):
            survivors[index].reason = "near_duplicate"
    for candidate in candidates:
        if candidate.reason is None:
            candidate.reason = golden_reason(candidate.row, golden, config)


def _judge_item(ref: int, candidate: _Candidate) -> JudgeItem:
    return JudgeItem(ref=ref, query=candidate.row.query, language=candidate.row.language, chunk_text=candidate.chunk_text)


def plan_judge_batches(pending: Sequence[_Candidate], batch_chars: int) -> list[list[_Candidate]]:
    batches: list[list[_Candidate]] = []
    current: list[_Candidate] = []
    size = 0
    for candidate in pending:
        cost = len(candidate.row.query) + len(candidate.chunk_text) + ITEM_OVERHEAD_CHARS
        if current and (size + cost > batch_chars or len(current) >= MAX_ITEMS_PER_BATCH):
            batches.append(current)
            current, size = [], 0
        current.append(candidate)
        size += cost
    if current:
        batches.append(current)
    return batches


def estimate_judge_usage(batch: Sequence[_Candidate], config: FinetuneConfig) -> Usage:
    items = [_judge_item(ref, c) for ref, c in enumerate(batch)]
    rendered = render_judge_items(items)
    text_chars = sum(len(item.query) + len(item.chunk_text) for item in items)
    system = judge_system_prompt(config.prompts.judge)
    input_tokens = (
        math.ceil(len(system) / DEFAULT_CHARS_PER_TOKEN)
        + math.ceil(max(0, len(rendered) - text_chars) / DEFAULT_CHARS_PER_TOKEN)
        + sum(estimate_tokens(item.query, item.language) + estimate_tokens(item.chunk_text, item.language) for item in items)
    )
    return Usage(input_tokens=input_tokens, output_tokens=len(items) * OUTPUT_TOKENS_PER_VERDICT)


def _verdict_reason(entry: JudgeCacheEntry, config: FilterConfig) -> str | None:
    if not entry.answerable:
        return "not_answerable"
    if entry.confidence < config.judge_min_confidence:
        return "low_confidence"
    return None


def build_report(candidates: Sequence[_Candidate], *, judge_skipped: bool) -> FilterReport:
    dropped = Counter({reason: 0 for reason in DROP_REASONS})
    languages: dict[str, Counter] = {}
    for candidate in candidates:
        counts = languages.setdefault(candidate.row.language, Counter())
        if candidate.reason is None:
            counts["kept"] += 1
        else:
            dropped[candidate.reason] += 1
            counts["dropped"] += 1
    return FilterReport(
        kept=sum(1 for c in candidates if c.reason is None),
        dropped={reason: dropped[reason] for reason in DROP_REASONS},
        by_language={
            language: LanguageFilterCounts(kept=counts["kept"], dropped=counts["dropped"])
            for language, counts in sorted(languages.items())
        },
        round_trip="not_applied",
        judge_skipped=judge_skipped,
    )


def _print(stream: TextIO, line: str) -> None:
    print(line, file=stream)


def _summary(report: FilterReport) -> str:
    return (
        f"kept={report.kept} "
        + " ".join(f"dropped_{reason}={count}" for reason, count in report.dropped.items())
        + " "
        + " ".join(f"{language}_kept={c.kept} {language}_dropped={c.dropped}" for language, c in report.by_language.items())
    )


def run_filter(
    run_dir: Path,
    *,
    budget_usd: float | None = None,
    skip_judge: bool = False,
    fixture: bool = False,
    dry_run: bool = False,
    llm: QueryLLM | None = None,
    config: FinetuneConfig | None = None,
    golden: GoldenIndex | None = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> FilterResult:
    out = out or sys.stdout
    err = err or sys.stderr
    config = config or load_finetune_config()
    price = config.prices.judge
    run_dir = Path(run_dir)
    try:
        if skip_judge and not fixture:
            raise FilterRefused("budget_required: --skip-judge is accepted only with --fixture; pass --budget-usd")
        if not dry_run and not skip_judge and budget_usd is None:
            raise FilterRefused("budget_required: pass --budget-usd (or --dry-run to project the cost)")
        if not dry_run and not skip_judge and not prices_known(price):
            raise FilterRefused("prices_unknown: set prices.judge in finetune.json to enforce --budget-usd")
        manifest, chunks, raw, test_raw = _checked_bundle(run_dir)
    except FilterRefused as exc:
        _print(err, f"[Finetune] filter refused: {exc.code}")
        return FilterResult(exc.exit_code)

    if golden is None:
        golden = GoldenIndex(load_golden_questions())
    chunks_by_key = {(chunk.tenant_key, chunk.chunk_id): chunk for chunk in chunks}
    candidates = [_Candidate(row, False) for row in raw] + [_Candidate(row, True) for row in test_raw]
    apply_rules(candidates, chunks_by_key, golden, config.filters)

    to_judge = [c for c in candidates if c.reason is None]
    cache = _JudgeCache(run_dir, config)
    verdicts: dict[int, JudgeCacheEntry] = {}
    if not skip_judge:
        for candidate in to_judge:
            entry = cache.get(candidate)
            if entry is not None:
                verdicts[id(candidate)] = entry
    pending = [c for c in to_judge if id(c) not in verdicts] if not skip_judge else []
    batches = plan_judge_batches(pending, config.generation.batch_chars)

    if dry_run:
        total = Usage()
        for batch in batches:
            total = total + estimate_judge_usage(batch, config)
        projection = project(total, price)
        cost = (
            f"cost_usd={projection.cost_usd:.6f}"
            if projection.cost_usd is not None
            else "cost unknown: set prices in finetune.json"
        )
        _print(
            out,
            f"[Finetune] filter dry-run run_id={manifest.run_id} raw={len(candidates)} judge_items={len(to_judge)} "
            f"cached={len(to_judge) - len(pending)} pending={len(pending)} batches={len(batches)} "
            f"input_tokens={projection.input_tokens} output_tokens={projection.output_tokens} {cost}",
        )
        return FilterResult(
            EXIT_OK,
            projection={
                "input_tokens": projection.input_tokens,
                "output_tokens": projection.output_tokens,
                "cost_usd": projection.cost_usd,
            },
        )

    if batches:
        try:
            meter = Budget(budget_usd, price)
        except (BudgetUnenforceable, ValueError) as exc:
            _print(err, f"[Finetune] filter refused: {str(exc).split(':')[0]}")
            return FilterResult(EXIT_USAGE)
        if llm is None:
            llm = AnthropicQueryLLM(config)
        calls = invalid = 0
        for batch in batches:
            if meter.would_exceed(estimate_judge_usage(batch, config)):
                _print(
                    err,
                    f"[Finetune] filter stopped: budget spent after {calls} judge calls (spent_usd={meter.spent_usd:.6f}); "
                    "re-run with a larger --budget-usd to resume from the cache",
                )
                return FilterResult(EXIT_BUDGET)
            calls += 1
            try:
                result = llm.judge_answerability(
                    [_judge_item(ref, c) for ref, c in enumerate(batch)], prompt_version=config.prompts.judge
                )
            except LLMOutputInvalid as exc:
                meter.charge(exc.usage)
                invalid += 1
                _print(err, f"[Finetune] filter judge batch {calls}: output_invalid {exc.code}")
                continue
            except LLMCallFailed as exc:
                _print(err, f"[Finetune] filter stopped: {exc}")
                return FilterResult(EXIT_FAILED)
            meter.charge(result.usage)
            if len(result.verdicts) != len(batch):
                invalid += 1
                _print(err, f"[Finetune] filter judge batch {calls}: output_invalid judge_refs_mismatch")
                continue
            for candidate, verdict in zip(batch, result.verdicts, strict=True):
                verdicts[id(candidate)] = cache.put(candidate, verdict.answerable, verdict.confidence)
        if invalid:
            _print(
                err,
                f"[Finetune] filter incomplete: {invalid} judge batches returned unusable output; re-run to judge them",
            )
            return FilterResult(EXIT_FAILED)

    if not skip_judge:
        for candidate in to_judge:
            candidate.reason = _verdict_reason(verdicts[id(candidate)], config.filters)

    kept_sha = bundle.write_jsonl(
        run_dir / KEPT_FILE, [c.row for c in candidates if not c.test and c.reason is None], RawSyntheticQuery
    )
    test_kept_sha = bundle.write_jsonl(
        run_dir / TEST_KEPT_FILE, [c.row for c in candidates if c.test and c.reason is None], RawSyntheticQuery
    )
    files = dict(manifest.files)
    files.update({KEPT_FILE: kept_sha, TEST_KEPT_FILE: test_kept_sha})
    bundle.write_manifest(run_dir, manifest.model_copy(update={"files": files}))

    report = build_report(candidates, judge_skipped=skip_judge)
    payload = json.dumps(report.model_dump(mode="json"), sort_keys=True, indent=2) + "\n"
    bundle._atomic_write(run_dir / REPORT_FILE, payload.encode("utf-8"))
    judge_note = "judge=skipped(fixture)" if skip_judge else f"judge_items={len(to_judge)} cached={len(to_judge) - len(pending)}"
    _print(out, f"[Finetune] filter run_id={manifest.run_id} raw={len(candidates)} {judge_note} {_summary(report)} round_trip=not_applied")
    return FilterResult(EXIT_OK, report=report)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.finetune filter")
    parser.add_argument("--bundle", required=True, type=Path, help="run directory written by export and generate")
    parser.add_argument("--budget-usd", type=float, default=None, help="judge spend limit (required unless --dry-run)")
    parser.add_argument("--dry-run", action="store_true", help="apply the rules and project the judge cost, call nothing")
    parser.add_argument("--fixture", action="store_true", help="fixture run (permits --skip-judge)")
    parser.add_argument("--skip-judge", action="store_true", help="skip the answerability judge (only with --fixture)")
    parser.add_argument("--config", type=Path, default=None, help="finetune.json (default eval/config/finetune.json)")
    return parser


def main(
    argv: list[str] | None = None,
    *,
    llm: QueryLLM | None = None,
    config: FinetuneConfig | None = None,
    golden: GoldenIndex | None = None,
) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return EXIT_USAGE if exc.code else EXIT_OK
    if config is None:
        try:
            config = load_finetune_config(args.config)
        except (ValueError, OSError):
            print("[Finetune] filter refused: config_invalid", file=sys.stderr)
            return EXIT_USAGE
    return run_filter(
        args.bundle,
        budget_usd=args.budget_usd,
        skip_judge=args.skip_judge,
        fixture=args.fixture,
        dry_run=args.dry_run,
        llm=llm,
        config=config,
        golden=golden,
    ).exit_code
