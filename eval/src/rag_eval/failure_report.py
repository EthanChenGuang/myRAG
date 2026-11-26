"""New eval failures by layer and category (Phase 7 D-23, taken over by Phase 5.1.1 D-02, EVAL-17).

Reads the private eval runs under eval/golden/private/runs/<run>/ that started on or after --since. A run directory holds
manifest.json (RunManifest), traces.jsonl (RagTrace lines), golden.jsonl (the scored items; when absent, the manifest's
golden_path, which must also be private), and optionally judge.json (JudgeReport) and report.json (EvalReport). Each failed
item gets one layer, the earliest that applies in LAYER_ORDER. Failures already listed in the previous report (same domain
set, item id and layer) are left out. Writes failure-report-<stamp>.json (FailureReport) and .md under
eval/golden/private/reports/: ids, categories, languages, layers, hashes and counts only, never question, answer or chunk text.
"""

import argparse
import hashlib
import re
import sys
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError
from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.feedback_loop import FailureEntry, FailureReport, LayerCounts
from rag_sidecar.contracts.golden import INJECTION_CATEGORIES, GoldenItem
from rag_sidecar.contracts.judge import JudgeReport

from rag_eval.draft import writer
from rag_eval.draft.writer import PrivatePathError, assert_private_path
from rag_eval.golden_io import load_golden
from rag_eval.matching import chunk_matches_span
from rag_eval.metrics import _attack_succeeded, _is_exposed
from rag_eval.paths import resolve_cli_path
from rag_eval.traces import load_manifest, load_traces

EXIT_OK, EXIT_INPUT, EXIT_PRIVATE = 0, 2, 6
SKIP_NOTICE = "::notice::[Failure Report] no private eval data; skipping"
RUNS_SUBDIR = "runs"
REPORTS_SUBDIR = "reports"
REPORT_PREFIX = "failure-report-"
LAYER_ORDER = ("retrieval", "rerank_or_assembly", "refusal", "generation", "groundedness", "injection")
GENERATION_JUDGE_METRIC = "answer_relevance"
GENERATION_JUDGE_FLOOR = 0.5
GENERATION_TOKEN_RECALL_FLOOR = 0.6
DOMAIN_SET_HASH_LENGTH = 16

_DATE_ONLY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_WORD = re.compile(r"\w+")
_CJK = re.compile(r"[㐀-䶿一-鿿]")


class ReportInputError(ValueError):
    pass


@dataclass(frozen=True)
class PrivateRun:
    run_dir: Path
    manifest: RunManifest
    started_at: datetime
    domain_set: str


def parse_since(text: str) -> datetime:
    """YYYY-MM-DD as UTC midnight, or an ISO 8601 date-time with an offset."""
    try:
        if _DATE_ONLY.match(text):
            return datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=UTC)
        value = datetime.fromisoformat(text)
    except ValueError:
        raise ReportInputError("--since must be YYYY-MM-DD or an ISO 8601 date-time") from None
    if value.tzinfo is None:
        raise ReportInputError("--since needs a UTC offset when it carries a time")
    return value.astimezone(UTC)


def iso_now(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).astimezone(UTC).isoformat().replace("+00:00", "Z")


def file_stamp(now: datetime) -> str:
    return now.astimezone(UTC).strftime("%Y%m%dT%H%M%S%fZ")


def domain_set_hash(golden_path: str) -> str:
    """The domain set is named by a hash of the golden file path the run scored, never by the path."""
    normalized = golden_path.replace("\\", "/").strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:DOMAIN_SET_HASH_LENGTH]


def default_runs_dir() -> Path:
    return writer.PRIVATE_DIR / RUNS_SUBDIR


def default_reports_dir() -> Path:
    return writer.PRIVATE_DIR / REPORTS_SUBDIR


def _started_at(manifest: RunManifest) -> datetime:
    try:
        value = datetime.fromisoformat(manifest.created_at)
    except ValueError:
        raise ReportInputError(f"run {manifest.run_id}: created_at is not an ISO 8601 date-time") from None
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)


def has_private_runs(runs_dir: Path) -> bool:
    return runs_dir.is_dir() and any((child / "manifest.json").is_file() for child in runs_dir.iterdir() if child.is_dir())


def load_private_runs(runs_dir: Path, since: datetime | None = None) -> list[PrivateRun]:
    """Run directories under runs_dir with a manifest, started on or after since, oldest first."""
    runs: list[PrivateRun] = []
    for child in sorted(p for p in runs_dir.iterdir() if p.is_dir()):
        manifest_path = assert_private_path(child / "manifest.json")
        if not manifest_path.is_file():
            continue
        try:
            manifest = load_manifest(manifest_path)
        except (OSError, ValueError) as exc:
            raise ReportInputError(f"{child.name}: {type(exc).__name__}") from None
        started = _started_at(manifest)
        if since is not None and started < since:
            continue
        runs.append(PrivateRun(child, manifest, started, domain_set_hash(manifest.golden_path)))
    runs.sort(key=lambda run: (run.started_at, run.manifest.run_id))
    return runs


def _tokens(text: str) -> list[str]:
    folded = unicodedata.normalize("NFKC", text).casefold()
    tokens: list[str] = []
    for word in _WORD.findall(folded):
        if _CJK.search(word):
            tokens.extend(char for char in word if not char.isspace())
        else:
            tokens.append(word)
    return tokens


def answer_matches(expected: str, answer: str) -> bool:
    """Deterministic match: the share of the expected answer's tokens found in the answer reaches the floor."""
    wanted = _tokens(expected)
    if not wanted:
        return True
    present = set(_tokens(answer))
    return sum(1 for token in wanted if token in present) / len(wanted) >= GENERATION_TOKEN_RECALL_FLOOR


def _gold_in(item: GoldenItem, chunks) -> bool:
    return any(
        chunk_matches_span(getattr(chunk, "document_name", None) or "", chunk.content, span)
        for chunk in chunks
        for span in item.gold_evidence
    )


def _layers(item: GoldenItem, trace: RagTrace, judge_score: float | None) -> list[str]:
    layers: list[str] = []
    if item.answerable:
        if item.gold_evidence:
            in_candidates = _gold_in(item, trace.candidates)
            in_kept = _gold_in(item, trace.kept)
            if not in_candidates and not in_kept:
                layers.append("retrieval")
            elif trace.refused:
                layers.append("refusal")
            elif not in_kept:
                layers.append("rerank_or_assembly")
        elif trace.refused:
            layers.append("refusal")
        if not trace.refused and trace.answer:
            if judge_score is not None:
                if judge_score < GENERATION_JUDGE_FLOOR:
                    layers.append("generation")
            elif item.expected_answer and not answer_matches(item.expected_answer, trace.answer):
                layers.append("generation")
    elif not trace.refused:
        layers.append("refusal")
    groundedness = trace.groundedness
    if groundedness is not None and groundedness.label == "possibly_unreliable":
        layers.append("groundedness")
    attack = item.attack if item.category in INJECTION_CATEGORIES else None
    if attack is not None and _attack_succeeded(attack, _is_exposed(attack, trace), trace.answer):
        layers.append("injection")
    return layers


def classify_layer(item: GoldenItem, trace: RagTrace, judge_score: float | None = None) -> str | None:
    """The earliest layer in LAYER_ORDER whose rule applies, or None for an item that passed."""
    found = set(_layers(item, trace, judge_score))
    return next((layer for layer in LAYER_ORDER if layer in found), None)


def _judge_scores(run_dir: Path) -> dict[str, float]:
    path = assert_private_path(run_dir / "judge.json")
    if not path.is_file():
        return {}
    try:
        report = JudgeReport.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError):
        raise ReportInputError(f"{run_dir.name}: judge.json is not a JudgeReport") from None
    return {
        score.item_id: score.score
        for score in report.items
        if score.metric == GENERATION_JUDGE_METRIC and score.score is not None
    }


def _run_inputs(run: PrivateRun) -> tuple[list[GoldenItem], list[RagTrace]] | None:
    traces_path = assert_private_path(run.run_dir / "traces.jsonl")
    if not traces_path.is_file():
        return None
    golden_path = run.run_dir / "golden.jsonl"
    if not golden_path.is_file():
        golden_path = resolve_cli_path(run.manifest.golden_path)
    golden_path = assert_private_path(golden_path)
    try:
        return load_golden(golden_path), load_traces(traces_path)
    except (OSError, ValueError) as exc:
        raise ReportInputError(f"{run.run_dir.name}: {type(exc).__name__} reading golden items or traces") from None


def run_failures(run: PrivateRun) -> list[FailureEntry] | None:
    """The failed items of one run, or None when the run has no traces."""
    inputs = _run_inputs(run)
    if inputs is None:
        return None
    golden, traces = inputs
    judge = _judge_scores(run.run_dir)
    by_id = {trace.item_id: trace for trace in traces if trace.item_id is not None}
    entries: list[FailureEntry] = []
    for item in golden:
        trace = by_id.get(item.id)
        if trace is None:
            continue
        layer = classify_layer(item, trace, judge.get(item.id))
        if layer is None:
            continue
        entries.append(
            FailureEntry(
                item_id=item.id,
                run_id=run.manifest.run_id,
                layer=layer,
                category=item.category,
                language=item.language,
                domain_set=run.domain_set,
            )
        )
    return entries


def _key(entry: FailureEntry) -> tuple[str | None, str, str]:
    return (entry.domain_set, entry.item_id, entry.layer)


def previous_report(reports_dir: Path) -> tuple[FailureReport, str] | None:
    if not reports_dir.is_dir():
        return None
    candidates = sorted(reports_dir.glob(f"{REPORT_PREFIX}*.json"))
    if not candidates:
        return None
    path = assert_private_path(candidates[-1])
    raw = path.read_bytes()
    try:
        report = FailureReport.model_validate_json(raw)
    except ValidationError:
        raise ReportInputError(f"{path.name} is not a FailureReport") from None
    return report, hashlib.sha256(raw).hexdigest()


def build_failure_report(
    runs: list[PrivateRun], since: datetime, previous: tuple[FailureReport, str] | None, *, now: datetime
) -> FailureReport:
    latest: dict[tuple[str | None, str, str], FailureEntry] = {}
    used: list[str] = []
    for run in runs:
        entries = run_failures(run)
        if entries is None:
            print(f"[Failure Report] run {run.manifest.run_id} has no traces; skipped", file=sys.stderr)
            continue
        used.append(run.manifest.run_id)
        for entry in entries:
            latest[_key(entry)] = entry
    seen = {_key(entry) for entry in previous[0].entries} if previous else set()
    fresh = [entry for key, entry in latest.items() if key not in seen]
    fresh.sort(key=lambda e: (LAYER_ORDER.index(e.layer), e.category, e.domain_set or "", e.item_id))
    counts = {layer: sum(1 for e in fresh if e.layer == layer) for layer in LAYER_ORDER}
    return FailureReport(
        generated_at=iso_now(now),
        since=iso_now(since),
        run_ids=used,
        previous_report_sha256=previous[1] if previous else None,
        by_layer=LayerCounts(**counts),
        entries=fresh,
    )


def render_failure_markdown(report: FailureReport, *, heading: str = "#") -> str:
    sub = heading + "#"
    lines = [
        f"{heading} Failure report",
        "",
        f"Generated {report.generated_at}; runs started on or after {report.since}: {len(report.run_ids)}.",
        f"Previous report sha256: {report.previous_report_sha256 or 'none'}.",
        "Failures already listed in the previous report are left out. Ids, categories and counts only.",
        "",
        "| Layer | New failures |",
        "|-------|--------------|",
    ]
    counts = report.by_layer.model_dump()
    lines.extend(f"| {layer} | {counts[layer]} |" for layer in LAYER_ORDER)
    lines.extend(["", f"{sub} New failures by layer and category", ""])
    if not report.entries:
        lines.extend(["None.", ""])
    for layer in LAYER_ORDER:
        in_layer = [e for e in report.entries if e.layer == layer]
        if not in_layer:
            continue
        lines.extend([f"{sub}# {layer}", ""])
        for category in sorted({e.category for e in in_layer}):
            in_category = [e for e in in_layer if e.category == category]
            lines.extend([f"{sub}## {category} ({len(in_category)})", ""])
            lines.extend(
                f"- {e.item_id} (run {e.run_id}, language {e.language or 'unknown'}, domain set {e.domain_set or 'unknown'})"
                for e in in_category
            )
            lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


def write_text(path: Path, text: str) -> None:
    path = assert_private_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def generate(since: datetime, runs_dir: Path, out_dir: Path, *, now: datetime | None = None) -> FailureReport | None:
    """Builds and writes the report; None when there is no private data. Paths must already be private."""
    if not has_private_runs(runs_dir):
        return None
    moment = now or datetime.now(UTC)
    report = build_failure_report(load_private_runs(runs_dir, since), since, previous_report(out_dir), now=moment)
    stamp = file_stamp(moment)
    write_text(out_dir / f"{REPORT_PREFIX}{stamp}.json", report.model_dump_json(indent=2) + "\n")
    write_text(out_dir / f"{REPORT_PREFIX}{stamp}.md", render_failure_markdown(report))
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.failure_report", description="New eval failures by layer and category")
    parser.add_argument("--since", required=True, help="YYYY-MM-DD or ISO 8601: runs started on or after it")
    parser.add_argument("--runs-dir", type=Path, default=None, help="default: eval/golden/private/runs")
    parser.add_argument("--out-dir", type=Path, default=None, help="default: eval/golden/private/reports")
    args = parser.parse_args(argv)

    try:
        runs_dir = assert_private_path(resolve_cli_path(args.runs_dir) if args.runs_dir else default_runs_dir())
        out_dir = assert_private_path(resolve_cli_path(args.out_dir) if args.out_dir else default_reports_dir())
    except PrivatePathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_PRIVATE
    try:
        since = parse_since(args.since)
        report = generate(since, runs_dir, out_dir)
    except PrivatePathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_PRIVATE
    except ReportInputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INPUT
    if report is None:
        print(SKIP_NOTICE)
        return EXIT_OK
    counts = " ".join(f"{layer}={value}" for layer, value in report.by_layer.model_dump().items())
    print(f"[Failure Report] runs={len(report.run_ids)} new_failures={len(report.entries)} {counts}")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
