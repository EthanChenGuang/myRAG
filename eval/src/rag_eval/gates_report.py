"""Gates section of the weekly report (Phase 5.3 D-17, D-19, D-36, D-50; WeeklyGatesSection).

Reads, each on its own and best effort (research Open Question 5):
- GET /api/rag/admin/config-changes?since= (admin Bearer): overrides listed with date, actor id, key names, hashes, result
  and the reason capped at 200 characters; every other change as a count by source and result; release overrides;
- rag-release-gate statuses on main described "override by <actor>" (GitHub API, only with a token and a repository);
- GET /api/rag/admin/monitor/alerts?status=open: open alerts by rule;
- GET /api/rag/admin/eval-run-requests: evaluation runs skipped in the window, by reason (no_real_set);
- eval/config/judge-calibration.json: cells by effective status (gating, report_only, uncalibrated);
- eval/golden/private/reports/drift-*.json: the latest drift week per tenant hash;
- the lifecycle manifests of the private sets: items overdue for re-review.
A source that cannot be read is marked not_read with a reason code; nothing here raises on a remote failure.
Numbers, ids, names, hashes, codes and the capped override reason only. Tokens are never printed or stored.
"""

import argparse
import json
import os
import re
import sys
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, get_args

from pydantic import ValidationError
from rag_sidecar.contracts.config_change import (
    RELEASE_SOURCES,
    ConfigChangeRecord,
    JudgeCellState,
    WeeklyChangeCount,
    WeeklyDrift,
    WeeklyGatesSection,
    WeeklyOverride,
    WeeklyReleaseOverride,
)
from rag_sidecar.contracts.monitor import DriftReport, MonitorRuleId
from rag_sidecar.contracts.release_gate import GIT_SHA_PATTERN, GITHUB_LOGIN_PATTERN

from rag_eval.draft import writer
from rag_eval.draft.writer import PrivatePathError, assert_private_path
from rag_eval.failure_report import (
    ReportInputError,
    file_stamp,
    iso_now,
    parse_since,
    write_text,
)
from rag_eval.paths import REPO_ROOT, resolve_cli_path

EXIT_OK, EXIT_INPUT, EXIT_PRIVATE = 0, 2, 6
DEFAULT_TOKEN_ENV = "RAG_ADMIN_BEARER"
DEFAULT_GITHUB_TOKEN_ENV = "GITHUB_TOKEN"
GITHUB_API = "https://api.github.com"
RELEASE_CONTEXT = "rag-release-gate"
MAIN_BRANCH = "main"
CHANGES_ROUTE = "/api/rag/admin/config-changes"
ALERTS_ROUTE = "/api/rag/admin/monitor/alerts"
EVAL_RUNS_ROUTE = "/api/rag/admin/eval-run-requests"
CHANGES_LIMIT = 500
ALERTS_PAGE = 50
EVAL_RUNS_PAGE = 20
MAX_PAGES = 40
MAX_COMMITS = 100
REASON_CAP = 200
SET_MANIFEST_NAME = "golden.manifest.json"
DOMAIN_SUBDIR = "domain"
REPORTS_SUBDIR = "reports"
REPORT_PREFIX = "gates-report-"
GITHUB_NOT_READ = "GitHub was not read"
DEFAULT_CALIBRATION_PATH = REPO_ROOT / "eval" / "config" / "judge-calibration.json"
DEFAULT_GATES_PATH = REPO_ROOT / "eval" / "config" / "quality-gates.json"

BLOCKS = ("config_changes", "github", "alerts", "eval_runs", "judge_cells", "drift", "re_review")
_OVERRIDE_RE = re.compile(r"^override by (?P<login>\S+)$")
_LOGIN_RE = re.compile(GITHUB_LOGIN_PATTERN)
_SHA_RE = re.compile(GIT_SHA_PATTERN)
_CODE_RE = re.compile(r"^[a-z0-9_]+$")
_REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_RULES = frozenset(get_args(MonitorRuleId))
_CELL_STATES: tuple[JudgeCellState, ...] = get_args(JudgeCellState)

ClientFactory = Callable[[], Any]


@dataclass(frozen=True)
class GithubSource:
    repository: str
    token: str
    api: str = GITHUB_API


@dataclass(frozen=True)
class GatesCollection:
    """The validated section plus what the contract has no field for: unread blocks, release sources, overdue per set."""

    section: WeeklyGatesSection
    not_read: dict[str, str] = field(default_factory=dict)
    release_sources: tuple[str, ...] = ()
    overdue_by_set: dict[str, int] = field(default_factory=dict)


class _NotRead(Exception):
    """Carries a reason code only; never a body, URL or token."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


def _get(factory: ClientFactory, url: str, headers: dict[str, str], params: dict[str, Any]) -> Any:
    try:
        with factory() as client:
            response = client.get(url, params=params, headers=headers)
    except Exception:  # noqa: BLE001 - transport errors never carry the token
        raise _NotRead("request_failed") from None
    if response.status_code != 200:
        raise _NotRead(f"http_{response.status_code}")
    try:
        return response.json()
    except ValueError:
        raise _NotRead("invalid_response") from None


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _cap(reason: str | None) -> str | None:
    return reason[:REASON_CAP] if isinstance(reason, str) and reason else None


def _read_changes(factory: ClientFactory, base: str, headers: dict[str, str], since: datetime) -> list[ConfigChangeRecord]:
    payload = _get(factory, base + CHANGES_ROUTE, headers, {"since": iso_now(since), "limit": CHANGES_LIMIT})
    rows = payload.get("records") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise _NotRead("invalid_response")
    records: list[ConfigChangeRecord] = []
    for row in rows:
        try:
            records.append(ConfigChangeRecord.model_validate(row))
        except ValidationError:
            continue
    return records


def _split_changes(
    records: Iterable[ConfigChangeRecord],
) -> tuple[list[WeeklyOverride], list[WeeklyChangeCount], list[WeeklyReleaseOverride]]:
    overrides: list[WeeklyOverride] = []
    releases: list[WeeklyReleaseOverride] = []
    counts: Counter[tuple[str, str]] = Counter()
    for record in records:
        summary = record.gate_summary
        if record.source == "release_override" and summary.release_sha and summary.github_actor:
            releases.append(
                WeeklyReleaseOverride(
                    date=record.created_at[:10],
                    sha=summary.release_sha,
                    github_actor=summary.github_actor,
                    override_reason=_cap(record.override_reason),
                )
            )
        elif record.source not in RELEASE_SOURCES and record.override_reason:
            overrides.append(
                WeeklyOverride(
                    date=record.created_at[:10],
                    actor=record.actor,
                    changed_keys=list(record.changed_keys),
                    before_hash=record.before_hash,
                    after_hash=record.after_hash,
                    gate_result=record.gate_result,
                    override_reason=_cap(record.override_reason),
                )
            )
        else:
            counts[(record.source, record.gate_result)] += 1
    change_counts = [
        WeeklyChangeCount(source=source, gate_result=result, count=count) for (source, result), count in sorted(counts.items())
    ]
    overrides.sort(key=lambda entry: (entry.date, entry.actor))
    return overrides, change_counts, releases


def _read_github(factory: ClientFactory, github: GithubSource, since: datetime) -> list[WeeklyReleaseOverride]:
    if not _REPOSITORY_RE.match(github.repository):
        raise _NotRead("invalid_repository")
    api = github.api.rstrip("/")
    headers = {
        "Authorization": f"Bearer {github.token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    commits = _get(
        factory,
        f"{api}/repos/{github.repository}/commits",
        headers,
        {"sha": MAIN_BRANCH, "since": iso_now(since), "per_page": MAX_COMMITS},
    )
    if not isinstance(commits, list):
        raise _NotRead("invalid_response")
    found: dict[tuple[str, str], WeeklyReleaseOverride] = {}
    for commit in commits[:MAX_COMMITS]:
        sha = commit.get("sha") if isinstance(commit, dict) else None
        if not isinstance(sha, str) or not _SHA_RE.match(sha):
            continue
        statuses = _get(factory, f"{api}/repos/{github.repository}/commits/{sha}/statuses", headers, {"per_page": 100})
        if not isinstance(statuses, list):
            raise _NotRead("invalid_response")
        for status in statuses:
            if not isinstance(status, dict) or status.get("context") != RELEASE_CONTEXT or status.get("state") != "success":
                continue
            match = _OVERRIDE_RE.match(str(status.get("description") or ""))
            created = _timestamp(status.get("created_at"))
            if match is None or created is None or created < since or not _LOGIN_RE.match(match.group("login")):
                continue
            key = (sha, match.group("login"))
            if key not in found:
                found[key] = WeeklyReleaseOverride(date=created.date().isoformat(), sha=sha, github_actor=key[1])
    return sorted(found.values(), key=lambda entry: (entry.date, entry.sha))


def _merge_releases(
    database: list[WeeklyReleaseOverride], github: list[WeeklyReleaseOverride]
) -> tuple[list[WeeklyReleaseOverride], tuple[str, ...]]:
    merged: list[WeeklyReleaseOverride] = list(database)
    sources = ["database"] * len(database)
    index = {(entry.sha, entry.github_actor): position for position, entry in enumerate(database)}
    for entry in github:
        position = index.get((entry.sha, entry.github_actor))
        if position is None:
            merged.append(entry)
            sources.append("github")
        else:
            sources[position] = "database+github"
    order = sorted(range(len(merged)), key=lambda position: (merged[position].date, merged[position].sha))
    return [merged[position] for position in order], tuple(sources[position] for position in order)


def _read_alerts(factory: ClientFactory, base: str, headers: dict[str, str]) -> dict[str, int]:
    counts: Counter[str] = Counter()
    cursor: str | None = None
    for _ in range(MAX_PAGES):
        params: dict[str, Any] = {"status": "open", "limit": ALERTS_PAGE}
        if cursor:
            params["cursor"] = cursor
        payload = _get(factory, base + ALERTS_ROUTE, headers, params)
        alerts = payload.get("alerts") if isinstance(payload, dict) else None
        if not isinstance(alerts, list):
            raise _NotRead("invalid_response")
        for alert in alerts:
            rule = alert.get("rule") if isinstance(alert, dict) else None
            if rule in _RULES and alert.get("status", "open") == "open":
                counts[rule] += 1
        cursor = payload.get("next_cursor")
        if not isinstance(cursor, str) or not cursor:
            break
    return dict(sorted(counts.items()))


def _read_skipped_runs(factory: ClientFactory, base: str, headers: dict[str, str], since: datetime) -> dict[str, int]:
    counts: Counter[str] = Counter()
    cursor: str | None = None
    for _ in range(MAX_PAGES):
        params: dict[str, Any] = {"limit": EVAL_RUNS_PAGE}
        if cursor:
            params["cursor"] = cursor
        payload = _get(factory, base + EVAL_RUNS_ROUTE, headers, params)
        rows = payload.get("requests") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise _NotRead("invalid_response")
        older = 0
        for row in rows:
            if not isinstance(row, dict):
                continue
            moment = _timestamp(row.get("updated_at")) or _timestamp(row.get("requested_at"))
            if moment is None or moment < since:
                older += 1
                continue
            reason = row.get("skip_reason")
            if row.get("status") == "skipped" and isinstance(reason, str) and _CODE_RE.match(reason):
                counts[reason] += 1
        cursor = payload.get("next_cursor")
        if not isinstance(cursor, str) or not cursor or (rows and older == len(rows)):
            break
    return dict(sorted(counts.items()))


def _judge_cells(calibration_path: Path, gates_path: Path, today: date) -> dict[str, int]:
    from rag_sidecar.contracts.judge_calibration import JudgeCalibration
    from rag_sidecar.contracts.quality_gates import QualityGates

    from rag_eval.judge_calibration import effective_status

    if not calibration_path.is_file():
        raise _NotRead("no_calibration_file")
    try:
        calibration = JudgeCalibration.model_validate_json(calibration_path.read_text(encoding="utf-8"))
        gates = QualityGates.model_validate_json(gates_path.read_text(encoding="utf-8"))
    except (OSError, ValidationError):
        raise _NotRead("invalid_calibration") from None
    counts: Counter[str] = Counter()
    for cell in calibration.cells:
        running = calibration.running_fingerprints.get(cell.role)
        counts[effective_status(cell, running, today, gates.judge.max_age_days)] += 1
    return {state: counts[state] for state in _CELL_STATES if counts[state]}


def _drift(reports_dir: Path) -> list[WeeklyDrift]:
    if not reports_dir.is_dir():
        raise _NotRead("no_reports")
    latest: dict[str, DriftReport] = {}
    for path in sorted(reports_dir.glob("drift-*.json")):
        try:
            report = DriftReport.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValidationError):
            continue
        if report.tenant_hash is None:
            continue
        current = latest.get(report.tenant_hash)
        if current is None or report.week > current.week:
            latest[report.tenant_hash] = report
    return [
        WeeklyDrift(tenant_hash=tenant, week=report.week, divergence=report.divergence, state=report.state)
        for tenant, report in sorted(latest.items())
    ]


def default_set_dirs() -> list[Path]:
    root = writer.PRIVATE_DIR / DOMAIN_SUBDIR
    if not root.is_dir():
        return []
    return sorted(path for path in root.iterdir() if path.is_dir() and (path / "golden.jsonl").is_file())


def _overdue(set_dirs: Sequence[Path], today: date) -> tuple[dict[str, int], int]:
    from rag_eval.golden_set import (
        LifecycleError,
        load_manifest,
        overdue_items,
        re_review_days,
    )

    days = re_review_days()
    by_set: dict[str, int] = {}
    missing = 0
    for set_dir in set_dirs:
        path = Path(set_dir) / SET_MANIFEST_NAME
        if not path.is_file():
            missing += 1
            continue
        try:
            manifest = load_manifest(path)
        except (LifecycleError, OSError, ValueError):
            missing += 1
            continue
        by_set[manifest.set_id] = by_set.get(manifest.set_id, 0) + len(overdue_items(manifest, today, days))
    return dict(sorted(by_set.items())), missing


def collect_gates_section(
    since: datetime,
    base_url: str | None,
    token: str | None,
    github: GithubSource | None,
    set_dirs: Sequence[Path],
    *,
    client_factory: ClientFactory | None = None,
    today: date | None = None,
    calibration_path: Path | None = None,
    gates_path: Path | None = None,
    reports_dir: Path | None = None,
    github_skip_reason: str = "no_token",
) -> GatesCollection:
    """Read every source on its own; one that cannot be read is recorded in not_read and leaves its block empty."""
    factory = client_factory or _http_client
    day = today or datetime.now(UTC).date()
    not_read: dict[str, str] = {}

    overrides: list[WeeklyOverride] = []
    change_counts: list[WeeklyChangeCount] = []
    database_releases: list[WeeklyReleaseOverride] = []
    open_alerts: dict[str, int] = {}
    skipped_runs: dict[str, int] = {}
    if not base_url or not token:
        reason = "no_base_url" if not base_url else "no_token"
        for block in ("config_changes", "alerts", "eval_runs"):
            not_read[block] = reason
    else:
        base = base_url.rstrip("/")
        headers = {"Authorization": f"Bearer {token}"}
        try:
            overrides, change_counts, database_releases = _split_changes(_read_changes(factory, base, headers, since))
        except _NotRead as exc:
            not_read["config_changes"] = exc.code
        try:
            open_alerts = _read_alerts(factory, base, headers)
        except _NotRead as exc:
            not_read["alerts"] = exc.code
        try:
            skipped_runs = _read_skipped_runs(factory, base, headers, since)
        except _NotRead as exc:
            not_read["eval_runs"] = exc.code

    github_releases: list[WeeklyReleaseOverride] = []
    if github is None or not github.token:
        not_read["github"] = github_skip_reason
    else:
        try:
            github_releases = _read_github(factory, github, since)
        except _NotRead as exc:
            not_read["github"] = exc.code
    releases, release_sources = _merge_releases(database_releases, github_releases)

    judge_cells: dict[str, int] = {}
    try:
        judge_cells = _judge_cells(calibration_path or DEFAULT_CALIBRATION_PATH, gates_path or DEFAULT_GATES_PATH, day)
    except _NotRead as exc:
        not_read["judge_cells"] = exc.code

    drift: list[WeeklyDrift] = []
    try:
        drift = _drift(reports_dir if reports_dir is not None else writer.PRIVATE_DIR / REPORTS_SUBDIR)
    except _NotRead as exc:
        not_read["drift"] = exc.code

    overdue_by_set, missing = _overdue(set_dirs, day)
    if missing:
        not_read["re_review"] = "manifest_missing"

    section = WeeklyGatesSection(
        overrides=overrides,
        change_counts=change_counts,
        release_overrides=releases,
        open_alerts=open_alerts,
        judge_cells=judge_cells,
        drift=drift,
        skipped_runs=skipped_runs,
        overdue_re_reviews=sum(overdue_by_set.values()),
    )
    ordered = {block: not_read[block] for block in BLOCKS if block in not_read}
    return GatesCollection(section=section, not_read=ordered, release_sources=release_sources, overdue_by_set=overdue_by_set)


def collection_payload(result: GatesCollection) -> dict[str, Any]:
    return {
        "gates": result.section.model_dump(mode="json"),
        "not_read": dict(result.not_read),
        "release_sources": list(result.release_sources),
        "overdue_by_set": dict(result.overdue_by_set),
    }


def _cell(value: str | None) -> str:
    if not value:
        return "none"
    return " ".join(value.split()).replace("|", "\\|")


def _rate(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.3f}"


def render_gates_markdown(result: GatesCollection | WeeklyGatesSection, heading: str = "##") -> str:
    if isinstance(result, WeeklyGatesSection):
        result = GatesCollection(section=result)
    section = result.section
    sub = heading + "#"
    lines = [f"{heading} Gates", "", "Overrides with the operator's reason (capped at 200 characters); every other gate event as counts.", ""]
    if result.not_read:
        lines.extend(f"- {block}: not read ({reason})" for block, reason in result.not_read.items())
        lines.append("")
    if "github" in result.not_read:
        lines.extend([f"{GITHUB_NOT_READ} ({result.not_read['github']}).", ""])

    lines.extend([f"{sub} Overrides", ""])
    if section.overrides:
        lines.extend(["| Date | Actor | Changed keys | Before | After | Result | Reason |", "|---|---|---|---|---|---|---|"])
        for entry in section.overrides:
            lines.append(
                f"| {entry.date} | {entry.actor} | {', '.join(entry.changed_keys) or 'none'} | {entry.before_hash[:12]} | "
                f"{entry.after_hash[:12]} | {entry.gate_result} | {_cell(entry.override_reason)} |"
            )
    else:
        lines.append("No overrides in the window.")
    lines.extend(["", f"{sub} Other configuration changes", ""])
    if section.change_counts:
        lines.extend(["| Source | Result | Count |", "|---|---|---|"])
        lines.extend(f"| {entry.source} | {entry.gate_result} | {entry.count} |" for entry in section.change_counts)
    else:
        lines.append("No other changes in the window.")
    lines.extend(["", f"{sub} Release overrides", ""])
    if section.release_overrides:
        sources = result.release_sources or ("database",) * len(section.release_overrides)
        lines.extend(["| Date | Commit | GitHub login | Source | Reason |", "|---|---|---|---|---|"])
        for entry, source in zip(section.release_overrides, sources, strict=True):
            lines.append(f"| {entry.date} | {entry.sha[:12]} | {entry.github_actor} | {source} | {_cell(entry.override_reason)} |")
    else:
        lines.append("No release overrides in the window.")
    lines.extend(["", f"{sub} Open alerts by rule", ""])
    if section.open_alerts:
        lines.extend(["| Rule | Open |", "|---|---|"])
        lines.extend(f"| {rule} | {count} |" for rule, count in section.open_alerts.items())
    else:
        lines.append("No open alerts.")
    lines.extend(["", f"{sub} Judge calibration cells", ""])
    lines.append(", ".join(f"{state} {section.judge_cells.get(state, 0)}" for state in _CELL_STATES))
    lines.extend(["", f"{sub} Drift (latest week per tenant hash)", ""])
    if section.drift:
        lines.extend(["| Tenant | Week | Divergence | State |", "|---|---|---|---|"])
        lines.extend(f"| {entry.tenant_hash} | {entry.week} | {_rate(entry.divergence)} | {entry.state} |" for entry in section.drift)
    else:
        lines.append("No drift report.")
    lines.extend(["", f"{sub} Skipped evaluation runs", ""])
    if section.skipped_runs:
        lines.extend(["| Reason | Runs |", "|---|---|"])
        lines.extend(f"| {reason} | {count} |" for reason, count in section.skipped_runs.items())
    else:
        lines.append("No skipped runs in the window.")
    lines.extend(["", f"{sub} Overdue re-reviews", "", f"Overdue items: {section.overdue_re_reviews}.", ""])
    if result.overdue_by_set:
        lines.extend(["| Set | Overdue |", "|---|---|"])
        lines.extend(f"| {set_id} | {count} |" for set_id, count in result.overdue_by_set.items())
        lines.append("")
    return "\n".join(lines)


def github_source(repository: str | None, token_env: str = DEFAULT_GITHUB_TOKEN_ENV) -> tuple[GithubSource | None, str]:
    token = (os.environ.get(token_env) or "").strip()
    if not token:
        return None, "no_token"
    if not repository:
        return None, "no_repository"
    return GithubSource(repository=repository, token=token), ""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.gates_report", description="Gates section of the weekly report (standalone)")
    parser.add_argument("--since", required=True, help="YYYY-MM-DD or ISO 8601 start of the window")
    parser.add_argument("--base-url", default=None, help="app base URL of the admin routes")
    parser.add_argument("--token-env", default=DEFAULT_TOKEN_ENV, help=f"variable with the admin Bearer token (default {DEFAULT_TOKEN_ENV})")
    parser.add_argument("--github-repository", default=None, help="owner/name whose main branch statuses are read")
    parser.add_argument("--github-token-env", default=DEFAULT_GITHUB_TOKEN_ENV)
    parser.add_argument("--set-dir", action="append", type=Path, default=None, help="private set directory (repeat); default every domain set")
    parser.add_argument("--calibration", type=Path, default=DEFAULT_CALIBRATION_PATH)
    parser.add_argument("--gates", type=Path, default=DEFAULT_GATES_PATH)
    parser.add_argument("--out-dir", type=Path, default=None, help="default: eval/golden/private/reports")
    args = parser.parse_args(argv)

    now = datetime.now(UTC)
    try:
        out_dir = assert_private_path(resolve_cli_path(args.out_dir) if args.out_dir else writer.PRIVATE_DIR / REPORTS_SUBDIR)
        since = parse_since(args.since)
        if since >= now:
            raise ReportInputError("--since must be in the past")
        set_dirs = [assert_private_path(resolve_cli_path(path)) for path in args.set_dir] if args.set_dir else default_set_dirs()
        github, github_reason = github_source(args.github_repository, args.github_token_env)
        result = collect_gates_section(
            since,
            args.base_url,
            (os.environ.get(args.token_env) or "").strip() or None,
            github,
            set_dirs,
            calibration_path=resolve_cli_path(args.calibration),
            gates_path=resolve_cli_path(args.gates),
            github_skip_reason=github_reason or "no_token",
        )
        payload = {"schema_version": 1, "generated_at": iso_now(now), "since": iso_now(since), **collection_payload(result)}
        stamp = file_stamp(now)
        write_text(out_dir / f"{REPORT_PREFIX}{stamp}.json", json.dumps(payload, indent=2, sort_keys=True) + "\n")
        write_text(out_dir / f"{REPORT_PREFIX}{stamp}.md", render_gates_markdown(result).rstrip("\n") + "\n")
    except PrivatePathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_PRIVATE
    except ReportInputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INPUT
    section = result.section
    print(
        f"[Gates Report] overrides={len(section.overrides)} release_overrides={len(section.release_overrides)} "
        f"open_alerts={sum(section.open_alerts.values())} overdue={section.overdue_re_reviews} "
        f"not_read={','.join(result.not_read) or 'none'}"
    )
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
