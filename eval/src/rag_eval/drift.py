"""D-43 to D-45: the weekly test-set drift report of one tenant.

Production cluster shares (30 days, `novel` included), online judge means and vote and refusal rates per slice come from
GET /api/rag/admin/monitor/drift-inputs (or a saved inputs file); test shares come from the private set's strata.json over the
gated population. The report holds the Jensen-Shannon divergence (base 2) with its seeded permutation null, the under-covered
clusters, the 8-week trend, the offline minus online judge gap per slice and the side-by-side rates. It is written under
eval/golden/private/reports/, the production shares beside the set (read by real-set reports), and the numbers are posted to
POST /api/rag/admin/monitor/drift, which recomputes every derived field. Output carries cluster ids, codes and numbers only.
"""

import argparse
import datetime as dt
import json
import math
import os
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import ValidationError
from rag_sidecar.contracts.judge import JudgeReport
from rag_sidecar.contracts.monitor import (
    HASH_PATTERN,
    SLICE_PATTERN,
    DriftCluster,
    DriftGap,
    DriftLimits,
    DriftRate,
    DriftReport,
    DriftScores,
    DriftTrendPoint,
    MonitorAlertsConfig,
    MonitorDriftBands,
)
from rag_sidecar.contracts.report import EvalReport

from rag_eval import representativeness
from rag_eval.draft import writer
from rag_eval.draft.writer import PrivatePathError, assert_private_path
from rag_eval.golden_set import LifecycleError
from rag_eval.paths import resolve_cli_path
from rag_eval.report import gated_recall_scores
from rag_eval.review_queue import DEFAULT_TOKEN_ENV, tenant_hash
from rag_eval.stats import jsd_bits, permutation_null_p95

EXIT_OK, EXIT_INPUT, EXIT_API, EXIT_PRIVATE = 0, 2, 4, 6

INPUTS_ROUTE = "/api/rag/admin/monitor/drift-inputs"
DRIFT_ROUTE = "/api/rag/admin/monitor/drift"
REPORTS_SUBDIR = "reports"
TREND_WEEKS = 8
NULL_ROUNDS = 1000
DEFAULT_SEED = 20260
DEFAULT_GAP_MIN_SAMPLE = 50
EPSILON = 1e-9
MONITOR_ALERTS_PATH = representativeness.MONITOR_ALERTS_PATH
_HASH_RE = re.compile(HASH_PATTERN)
_SLICE_RE = re.compile(SLICE_PATTERN)
_RATE_METRICS = ("refusal_rate", "not_helpful_rate")


class DriftError(Exception):
    pass


def _http_client():
    import httpx

    return httpx.Client(timeout=60.0)


def iso_week(day: dt.date | None = None) -> str:
    year, week, _ = (day or dt.datetime.now(dt.timezone.utc).date()).isocalendar()
    return f"{year}-W{week:02d}"


def production_shares(production: Mapping[str, Any]) -> dict[str, float]:
    """Cluster id to share from the drift inputs; counts win over shares when both are present."""
    clusters = production.get("clusters") or []
    counts = {str(c["id"]): float(c.get("n", 0) or 0) for c in clusters if isinstance(c, dict) and c.get("id")}
    total = math.fsum(counts.values())
    if total > 0:
        return {cluster: n / total for cluster, n in counts.items() if n > 0}
    shares = {str(c["id"]): float(c.get("share", 0) or 0) for c in clusters if isinstance(c, dict) and c.get("id")}
    total = math.fsum(shares.values())
    return {cluster: share / total for cluster, share in shares.items() if share > 0} if total > 0 else {}


def state_and_reason(
    divergence: float | None,
    null_p95: float | None,
    test_items: int,
    bands: MonitorDriftBands,
    min_sample: int = 0,
    warn: float | None = None,
    alert: float | None = None,
) -> tuple[str, str | None]:
    """The drift state with the reason it is ok (the rule of driftAlerts in src/lib/rag/monitor/rules.ts)."""
    warn = bands.jsd_warn if warn is None else warn
    alert = bands.jsd_alert if alert is None else alert
    if test_items < max(min_sample, bands.min_test_items):
        return "ok", "insufficient_test_items"
    if divergence is None or null_p95 is None:
        return "ok", "no_production_data"
    if divergence < warn - EPSILON:
        return "ok", "below_warn"
    if divergence <= null_p95:
        return "ok", "within_null"
    return ("alert" if divergence >= alert - EPSILON else "warn"), None


def _cluster_state(production: float, test: float, bands: MonitorDriftBands, tolerance: float) -> str:
    if production >= bands.under_covered_min_share - EPSILON and test < bands.under_covered_ratio * production:
        return "under"
    if abs(test - production) > tolerance + EPSILON:
        return "off"
    return "ok"


def _mean(values: Iterable[float | None]) -> float | None:
    kept = [float(v) for v in values if v is not None and math.isfinite(v)]
    return math.fsum(kept) / len(kept) if kept else None


def _offline_judge(offline: JudgeReport | None, slice_key: str) -> float | None:
    """Mean over the offline judge metrics of a slice: `all` is overall, `language:<code>` the language block."""
    if offline is None:
        return None
    if slice_key == "all":
        block = offline.overall
    elif slice_key.startswith("language:"):
        block = offline.by_language.get(slice_key.split(":", 1)[1], {})
    else:
        return None
    return _mean(metric.value for metric in block.values())


def _offline_refusal(eval_report: EvalReport | None, slice_key: str) -> float | None:
    if eval_report is None:
        return None
    items = eval_report.items
    if slice_key.startswith("language:"):
        language = slice_key.split(":", 1)[1]
        items = [item for item in items if item.language == language]
    elif slice_key != "all":
        return None
    return sum(1 for item in items if item.refused) / len(items) if items else None


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _count(value: Any) -> int:
    number = _number(value)
    return int(number) if number is not None and number > 0 else 0


def _share(value: Any) -> float | None:
    number = _number(value)
    return number if number is not None and 0 <= number <= 1 else None


def _slices(production: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw = production.get("slices") or []
    return [entry for entry in raw if isinstance(entry, dict) and isinstance(entry.get("slice"), str) and _SLICE_RE.match(entry["slice"])]


def build_drift_report(
    production: Mapping[str, Any],
    test_strata: Mapping[str, Any],
    offline_report: JudgeReport | None,
    previous: Sequence[DriftReport],
    bands: MonitorDriftBands,
    seed: int,
    *,
    week: str | None = None,
    eval_report: EvalReport | None = None,
    tolerance: float = representativeness.DEFAULT_TOLERANCE,
    gap_min_sample: int = DEFAULT_GAP_MIN_SAMPLE,
    drift_min_sample: int = 0,
    tenant_key: str | None = None,
) -> DriftReport:
    week = week or iso_week()
    prod = production_shares(production)
    counts = representativeness.cluster_counts(test_strata)
    n_test = sum(counts.values())
    test = {cluster: count / n_test for cluster, count in counts.items()} if n_test else {}

    divergence = null_p95 = None
    if prod and n_test > 0:
        divergence = jsd_bits(prod, test)
        null_p95 = permutation_null_p95(prod, n_test, seed, rounds=NULL_ROUNDS)
    state, _ = state_and_reason(divergence, null_p95, n_test, bands, drift_min_sample)

    clusters = [
        DriftCluster(
            id=cluster,
            production_share=prod.get(cluster, 0.0),
            test_share=test.get(cluster, 0.0),
            test_items=counts.get(cluster, 0),
            state=_cluster_state(prod.get(cluster, 0.0), test.get(cluster, 0.0), bands, tolerance),
        )
        for cluster in sorted(set(prod) | set(test))
    ]

    gaps: list[DriftGap] = []
    rates: list[DriftRate] = []
    for entry in _slices(production):
        key = entry["slice"]
        judge = entry.get("online_judge") if isinstance(entry.get("online_judge"), dict) else {}
        online, online_n = _share(judge.get("mean")), _count(judge.get("n"))
        offline = _offline_judge(offline_report, key)
        gap = offline - online if offline is not None and online is not None else None
        result = (
            "insufficient_n"
            if gap is None or online_n < gap_min_sample
            else "failed" if gap >= bands.gap_alert - EPSILON else "passed"
        )
        gaps.append(DriftGap(slice=key, offline=offline, online=online, online_n=online_n, gap=gap, result=result))
        for metric in _RATE_METRICS:
            rate = entry.get(metric) if isinstance(entry.get(metric), dict) else {}
            rates.append(
                DriftRate(
                    slice=key,
                    metric=metric,
                    online=_share(rate.get("value")),
                    online_n=_count(rate.get("n")),
                    offline=_offline_refusal(eval_report, key) if metric == "refusal_rate" else None,
                )
            )

    scores = None
    if eval_report is not None:
        item_scores = gated_recall_scores(eval_report)
        scores = DriftScores(
            unweighted=eval_report.overall.recall_at_5.value,
            weighted=representativeness.weighted_score(item_scores, test_strata, prod),
            uncovered_share=representativeness.uncovered_share(test_strata, prod, item_scores) if prod else None,
        )

    earlier = sorted((report for report in previous if report.week < week), key=lambda report: report.week)
    trend = [DriftTrendPoint(week=r.week, divergence=r.divergence, state=r.state) for r in earlier[-TREND_WEEKS:]]

    hashed = production.get("tenant_hash")
    if not (isinstance(hashed, str) and _HASH_RE.match(hashed)):
        hashed = tenant_hash(tenant_key) if tenant_key else None
    return DriftReport(
        week=week,
        tenant_hash=hashed,
        divergence=divergence,
        state=state,
        null_p95=null_p95,
        limits=DriftLimits(warn=bands.jsd_warn, alert=bands.jsd_alert, gap=bands.gap_alert),
        trend=trend,
        clusters=clusters,
        scores=scores,
        gaps=gaps,
        rates=rates,
    )


def _reports_dir() -> Path:
    return writer.PRIVATE_DIR / REPORTS_SUBDIR


def _write_json(path: Path, payload: Any) -> Path:
    target = assert_private_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_bytes((json.dumps(payload, sort_keys=True, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    os.replace(tmp, target)
    return target


def previous_reports(tenant_hash_value: str | None) -> list[DriftReport]:
    """Earlier weekly reports of the same tenant under the private reports directory; unreadable files are skipped."""
    found: list[DriftReport] = []
    directory = _reports_dir()
    if not directory.is_dir():
        return found
    for path in sorted(directory.glob("drift-*.json")):
        try:
            report = DriftReport.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValidationError):
            continue
        if report.tenant_hash == tenant_hash_value:
            found.append(report)
    return found


def _request(method: str, url: str, token: str, **kwargs: Any) -> Any:
    try:
        with _http_client() as client:
            response = client.request(method, url, headers={"Authorization": f"Bearer {token}"}, **kwargs)
    except Exception as exc:
        raise DriftError(f"{method} {url.rsplit('/', 1)[-1]} request failed: {type(exc).__name__}") from None
    if response.status_code != 200:
        raise DriftError(f"{method} {url.rsplit('/', 1)[-1]} answered HTTP {response.status_code}")
    try:
        return response.json()
    except ValueError:
        raise DriftError(f"{method} {url.rsplit('/', 1)[-1]} answered a body that is not JSON") from None


def fetch_inputs(base_url: str, token: str, tenant: str) -> dict[str, Any]:
    payload = _request("GET", base_url.rstrip("/") + INPUTS_ROUTE, token, params={"tenant": tenant})
    if not isinstance(payload, dict) or not isinstance(payload.get("clusters"), list):
        raise DriftError("drift-inputs answered without a clusters list")
    return payload


def post_report(base_url: str, token: str, tenant: str, report: DriftReport) -> dict[str, Any]:
    body = {"tenant": tenant, "report": report.model_dump(mode="json", exclude_none=True)}
    payload = _request("POST", base_url.rstrip("/") + DRIFT_ROUTE, token, json=body)
    return payload if isinstance(payload, dict) else {}


def _load_config(path: Path) -> MonitorAlertsConfig:
    return MonitorAlertsConfig.model_validate_json(Path(path).read_text(encoding="utf-8"))


def _rule_min_sample(config: MonitorAlertsConfig, kind: str, default: int) -> int:
    rule = next((r for r in config.rules if r.enabled and r.kind == kind), None)
    return rule.min_sample if rule is not None and rule.min_sample is not None else default


def _gated_strata(set_path: Path, manifest: Path | None) -> dict[str, Any]:
    strata = representativeness.load_strata(representativeness.set_dir_of(set_path) / representativeness.STRATA_NAME)
    gated = {item.id for item in representativeness.load_gated_set(set_path, manifest)}
    return {"items": [entry for entry in strata["items"] if entry.get("item_id") in gated]}


def _print_summary(report: DriftReport, reason: str | None, test_items: int) -> None:
    def fmt(value: float | None) -> str:
        return "n/a" if value is None else f"{value:.4f}"

    print(
        f"drift week={report.week} state={report.state} reason={reason or '-'} divergence={fmt(report.divergence)} "
        f"null_p95={fmt(report.null_p95)} test_items={test_items}"
    )
    under = [cluster.id for cluster in report.clusters if cluster.state == "under"]
    print(f"under-covered: {', '.join(under) if under else 'none'}")
    for gap in report.gaps:
        if gap.result == "failed":
            print(f"gap failed: {gap.slice} offline={fmt(gap.offline)} online={fmt(gap.online)} n={gap.online_n}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.drift", description=__doc__)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--set", required=True, help="private set directory (golden.jsonl, strata.json) or its JSONL file")
    parser.add_argument("--base-url", default=os.environ.get("RAG_APP_BASE_URL", ""))
    parser.add_argument("--token-env", default=DEFAULT_TOKEN_ENV)
    parser.add_argument("--offline-report", help="judge.json of the latest offline run")
    parser.add_argument("--eval-report", help="report.json of the latest offline run (weighted score, offline refusal rates)")
    parser.add_argument("--inputs", help="saved drift-inputs JSON, used when no base URL or token is set")
    parser.add_argument("--manifest", help="golden-set manifest for lifecycle statuses")
    parser.add_argument("--week", default=None, help="ISO week label, default the current week")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--config", default=str(MONITOR_ALERTS_PATH))
    args = parser.parse_args(argv)

    set_path = resolve_cli_path(args.set)
    set_dir = representativeness.set_dir_of(set_path)
    if not representativeness.golden_path(set_path).is_file() or not (set_dir / representativeness.STRATA_NAME).is_file():
        print("::notice::no private set with strata.json, skipping the drift report")
        return EXIT_OK
    try:
        assert_private_path(set_dir / representativeness.STRATA_NAME)
    except PrivatePathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_PRIVATE

    token = os.environ.get(args.token_env, "").strip()
    online = bool(args.base_url and token)
    try:
        config = _load_config(resolve_cli_path(args.config))
        strata = _gated_strata(set_path, resolve_cli_path(args.manifest) if args.manifest else None)
        offline = (
            JudgeReport.model_validate_json(resolve_cli_path(args.offline_report).read_text(encoding="utf-8"))
            if args.offline_report
            else None
        )
        eval_report = (
            EvalReport.model_validate_json(resolve_cli_path(args.eval_report).read_text(encoding="utf-8"))
            if args.eval_report
            else None
        )
        if online:
            production = fetch_inputs(args.base_url, token, args.tenant)
        elif args.inputs:
            production = json.loads(resolve_cli_path(args.inputs).read_text(encoding="utf-8"))
        else:
            print("::notice::admin base URL or token not configured and no --inputs, skipping the drift report")
            return EXIT_OK
    except DriftError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_API
    except (OSError, ValueError, ValidationError, LifecycleError) as exc:
        print(f"error: {type(exc).__name__}: could not read the drift inputs, set or offline reports", file=sys.stderr)
        return EXIT_INPUT
    if not isinstance(production, dict):
        print("error: drift inputs must be a JSON object", file=sys.stderr)
        return EXIT_INPUT

    week = args.week or iso_week()
    drift_min = _rule_min_sample(config, "drift", 0)
    hashed = production.get("tenant_hash") if isinstance(production.get("tenant_hash"), str) else tenant_hash(args.tenant)
    report = build_drift_report(
        production,
        strata,
        offline,
        previous_reports(hashed),
        config.drift,
        args.seed,
        week=week,
        eval_report=eval_report,
        tolerance=config.sampling.quota_tolerance,
        gap_min_sample=_rule_min_sample(config, "offline_online_gap", DEFAULT_GAP_MIN_SAMPLE),
        drift_min_sample=drift_min,
        tenant_key=args.tenant,
    )
    test_items = sum(cluster.test_items for cluster in report.clusters)
    _, reason = state_and_reason(report.divergence, report.null_p95, test_items, config.drift, drift_min)
    try:
        path = _write_json(
            _reports_dir() / f"drift-{report.tenant_hash or 'tenant'}-{week}.json", report.model_dump(mode="json", exclude_none=True)
        )
        _write_json(
            set_dir / representativeness.PRODUCTION_SHARES_NAME,
            {"schema_version": 1, "week": week, "total": _count(production.get("total")), "shares": production_shares(production)},
        )
    except PrivatePathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_PRIVATE
    _print_summary(report, reason, test_items)
    print(f"report written: {path.name}")

    if not online:
        print("::notice::admin base URL or token not configured, the drift report was not posted")
        return EXIT_OK
    if report.divergence is None:
        print("::notice::no divergence to post (no production shares or no test items)")
        return EXIT_OK
    try:
        answer = post_report(args.base_url, token, args.tenant, report)
    except DriftError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_API
    alerts = answer.get("alerts") if isinstance(answer.get("alerts"), dict) else {}
    print(f"posted: state={answer.get('state', '-')} opened={_count(alerts.get('opened'))} updated={_count(alerts.get('updated'))}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
