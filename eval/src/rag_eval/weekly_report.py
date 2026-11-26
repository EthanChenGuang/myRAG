"""Weekly feedback-loop report (Phase 5.1.1 D-25, FBK-10).

Combines three sections and writes weekly-report-<stamp>.json (WeeklyReport) and .md under eval/golden/private/reports/:
- loop statistics from GET /api/rag/admin/feedback-loop/stats per tenant hash (skipped with a reason code when no base URL
  or token is given, or the route does not answer 200);
- the trend of the last 8 private eval runs per domain set (runs with report.json), oldest first, each with its gate
  population, config hash and golden manifest hash; a run whose population or manifest hash differs from the previous run of
  its domain set is marked "not comparable";
- the failure report since --since (rag_eval.failure_report; written too, so next week lists only new failures).
Counts, ids, hashes and codes only, never question, answer or chunk text. No private runs: a skip notice and exit 0.
"""

import argparse
import os
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError
from rag_sidecar.contracts.feedback_loop import (
    EvalTrendPoint,
    FailureReport,
    FeedbackLoopStats,
    WeeklyReport,
)
from rag_sidecar.contracts.report import EvalReport

from rag_eval import failure_report as failures
from rag_eval.draft.writer import PrivatePathError, assert_private_path
from rag_eval.failure_report import (
    PrivateRun,
    ReportInputError,
    file_stamp,
    iso_now,
    parse_since,
    write_text,
)
from rag_eval.paths import resolve_cli_path

EXIT_OK, EXIT_INPUT, EXIT_PRIVATE = 0, 2, 6
SKIP_NOTICE = "::notice::[Weekly Report] no private eval data; skipping"
STATS_ROUTE = "/api/rag/admin/feedback-loop/stats"
DEFAULT_TOKEN_ENV = "RAG_ADMIN_BEARER"
REPORT_PREFIX = "weekly-report-"
TREND_RUNS = 8
NOT_COMPARABLE = "not comparable"

_SHA256 = re.compile(r"^[a-f0-9]{64}$")


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


def fetch_stats(base_url: str | None, token: str | None, since: datetime, until: datetime) -> tuple[FeedbackLoopStats | None, str | None]:
    """The stats route's FeedbackLoopStats, or None and a reason code. The token is never printed or stored."""
    if not base_url:
        return None, "no_base_url"
    if not token:
        return None, "no_token"
    url = base_url.rstrip("/") + STATS_ROUTE
    try:
        with _http_client() as client:
            response = client.get(
                url,
                params={"since": iso_now(since), "until": iso_now(until)},
                headers={"Authorization": f"Bearer {token}"},
            )
    except Exception:  # noqa: BLE001 - transport errors never carry the token
        return None, "stats_request_failed"
    if response.status_code != 200:
        return None, f"stats_http_{response.status_code}"
    try:
        payload = response.json()
        return FeedbackLoopStats.model_validate(payload.get("stats") if isinstance(payload, dict) else None), None
    except (ValueError, ValidationError):
        return None, "stats_invalid_response"


def _value(metric) -> float | None:
    return metric.value if metric is not None else None


def _trend_point(run: PrivateRun) -> EvalTrendPoint | None:
    path = assert_private_path(run.run_dir / "report.json")
    if not path.is_file():
        return None
    try:
        report = EvalReport.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError):
        raise ReportInputError(f"{run.run_dir.name}: report.json is not an EvalReport") from None
    overall = report.overall
    return EvalTrendPoint(
        domain_set=run.domain_set,
        run_id=report.run_id,
        started_at=iso_now(run.started_at),
        gate_population=report.gate_population,
        config_hash=report.run_config_hash[:128],
        manifest_hash=report.golden_sha256 if _SHA256.match(report.golden_sha256) else None,
        recall_at_5=_value(overall.recall_at_5),
        recall_at_10=_value(overall.recall_at_10),
        mrr=_value(overall.mrr),
        correct_refusal_rate=_value(overall.correct_refusal_rate),
        false_refusal_rate=_value(overall.false_refusal_rate),
    )


def build_trend(runs: list[PrivateRun], limit: int = TREND_RUNS) -> list[EvalTrendPoint]:
    by_set: dict[str, list[EvalTrendPoint]] = {}
    for run in runs:
        point = _trend_point(run)
        if point is not None:
            by_set.setdefault(point.domain_set, []).append(point)
    trend: list[EvalTrendPoint] = []
    for domain_set in sorted(by_set):
        trend.extend(by_set[domain_set][-limit:])
    return trend


def comparability(trend: list[EvalTrendPoint]) -> list[str]:
    """Per point: first, comparable, or not comparable with the reason, against the previous point of its domain set."""
    previous: dict[str, EvalTrendPoint] = {}
    labels: list[str] = []
    for point in trend:
        before = previous.get(point.domain_set)
        reasons = []
        if before is not None:
            if before.gate_population != point.gate_population:
                reasons.append("population changed")
            if before.manifest_hash != point.manifest_hash:
                reasons.append("manifest changed")
        labels.append("first" if before is None else (f"{NOT_COMPARABLE} ({', '.join(reasons)})" if reasons else "comparable"))
        previous[point.domain_set] = point
    return labels


def _rate(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.3f}"


def _short(value: str | None) -> str:
    return value[:12] if value else "none"


def _stats_lines(report: WeeklyReport) -> list[str]:
    lines = ["## Loop statistics", ""]
    if report.stats is None:
        return [*lines, f"Loop statistics skipped ({report.stats_skipped_reason}).", ""]
    stats = report.stats
    lines.append(f"Window {stats.since} to {stats.until}. Tenants are named by hash.")
    lines.append("")
    if not stats.tenants:
        return [*lines, "No retrievals or review items in the window.", ""]
    lines.extend(
        [
            (
                "| Tenant | Retrievals | Chat | Embed | Voice | Refusal rate | Zero-result rate | Low-score rate | Votes up | "
                "Votes down | Thumbs-down rate | Refusal disputes | Source-open rate | Mined | Labelled | Skipped | Exported |"
            ),
            "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
        ]
    )
    for tenant in stats.tenants:
        votes = tenant.votes
        up = votes.answer_up + votes.refusal_up + votes.embed_up
        down = votes.answer_down + votes.refusal_down + votes.embed_down
        channels = tenant.retrievals_by_channel
        lines.append(
            f"| {tenant.tenant_hash} | {tenant.retrievals} | {channels.chat} | {channels.embed} | {channels.voice} | "
            f"{_rate(tenant.refusal_rate)} | {_rate(tenant.zero_result_rate)} | {_rate(tenant.low_score_rate)} | {up} | {down} | "
            f"{_rate(tenant.thumbs_down_rate)} | {tenant.refusal_disputes} | {_rate(tenant.source_open_rate)} | "
            f"{tenant.items_mined} | {tenant.items_labelled} | {tenant.items_skipped} | {tenant.items_exported} |"
        )
    lines.extend(["", "| Tenant | Votes by kind (up/down) | Triage |", "|---|---|---|"])
    for tenant in stats.tenants:
        votes = tenant.votes
        kinds = (
            f"answer {votes.answer_up}/{votes.answer_down}, refusal {votes.refusal_up}/{votes.refusal_down}, "
            f"embed {votes.embed_up}/{votes.embed_down}"
        )
        triage = ", ".join(f"{name} {count}" for name, count in tenant.triage.model_dump().items())
        lines.append(f"| {tenant.tenant_hash} | {kinds} | {triage} |")
    return [*lines, ""]


def _trend_lines(report: WeeklyReport) -> list[str]:
    lines = ["## Eval trend", "", f"The last {TREND_RUNS} private eval runs per domain set, oldest first.", ""]
    if not report.trend:
        return [*lines, "No private eval run has a report.json.", ""]
    labels = comparability(report.trend)
    current = None
    for index, (point, label) in enumerate(zip(report.trend, labels, strict=True)):
        if point.domain_set != current:
            current = point.domain_set
            lines.extend(
                [
                    f"### Domain set {current}",
                    "",
                    (
                        "| Run | Started | Population | Config hash | Manifest hash | Recall@5 | Recall@10 | MRR | "
                        "Correct refusal | False refusal | Comparable |"
                    ),
                    "|---|---|---|---|---|---|---|---|---|---|---|",
                ]
            )
        lines.append(
            f"| {point.run_id} | {point.started_at} | {point.gate_population} | {_short(point.config_hash)} | "
            f"{_short(point.manifest_hash)} | {_rate(point.recall_at_5)} | {_rate(point.recall_at_10)} | {_rate(point.mrr)} | "
            f"{_rate(point.correct_refusal_rate)} | {_rate(point.false_refusal_rate)} | {label} |"
        )
        if index + 1 == len(report.trend) or report.trend[index + 1].domain_set != current:
            lines.append("")
    return lines


def render_weekly_markdown(report: WeeklyReport) -> str:
    lines = [
        "# Weekly feedback-loop report",
        "",
        f"Generated {report.generated_at}; window {report.since} to {report.until}. Counts, ids, hashes and codes only.",
        "",
        *_stats_lines(report),
        *_trend_lines(report),
    ]
    if report.failures is None:
        lines.extend(["## Failure report", "", "No failure report.", ""])
    else:
        lines.append(failures.render_failure_markdown(report.failures, heading="##"))
    return "\n".join(lines).rstrip("\n") + "\n"


def _load_failure_report(path: Path) -> FailureReport:
    path = assert_private_path(path)
    try:
        return FailureReport.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError):
        raise ReportInputError(f"{path.name} is not a FailureReport") from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.weekly_report", description="Weekly feedback-loop report")
    parser.add_argument("--since", required=True, help="YYYY-MM-DD or ISO 8601 start of the window")
    parser.add_argument("--until", default=None, help="end of the window (default: now)")
    parser.add_argument("--base-url", default=None, help="app base URL for the loop statistics route")
    parser.add_argument("--token-env", default=DEFAULT_TOKEN_ENV, help=f"environment variable with the admin Bearer token (default {DEFAULT_TOKEN_ENV})")
    parser.add_argument("--runs-dir", type=Path, default=None, help="default: eval/golden/private/runs")
    parser.add_argument("--out-dir", type=Path, default=None, help="default: eval/golden/private/reports")
    parser.add_argument("--failure-report", type=Path, default=None, help="embed this FailureReport instead of generating one")
    args = parser.parse_args(argv)

    try:
        runs_dir = assert_private_path(resolve_cli_path(args.runs_dir) if args.runs_dir else failures.default_runs_dir())
        out_dir = assert_private_path(resolve_cli_path(args.out_dir) if args.out_dir else failures.default_reports_dir())
    except PrivatePathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_PRIVATE

    now = datetime.now(UTC)
    try:
        since = parse_since(args.since)
        until = parse_since(args.until) if args.until else now
        if since >= until:
            raise ReportInputError("--since must be before --until")
        if not failures.has_private_runs(runs_dir):
            print(SKIP_NOTICE)
            return EXIT_OK
        trend = build_trend(failures.load_private_runs(runs_dir))
        if args.failure_report is not None:
            failure = _load_failure_report(resolve_cli_path(args.failure_report))
        else:
            failure = failures.generate(since, runs_dir, out_dir, now=now)
        stats, reason = fetch_stats(args.base_url, os.environ.get(args.token_env) or None, since, until)
        report = WeeklyReport(
            generated_at=iso_now(now),
            since=iso_now(since),
            until=iso_now(until),
            stats=stats,
            stats_skipped_reason=reason,
            trend=trend,
            failures=failure,
        )
        stamp = file_stamp(now)
        write_text(out_dir / f"{REPORT_PREFIX}{stamp}.json", report.model_dump_json(indent=2) + "\n")
        write_text(out_dir / f"{REPORT_PREFIX}{stamp}.md", render_weekly_markdown(report))
    except PrivatePathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_PRIVATE
    except ReportInputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INPUT
    print(
        f"[Weekly Report] trend_points={len(report.trend)} stats={'included' if stats else reason} "
        f"new_failures={len(failure.entries) if failure else 0}"
    )
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
