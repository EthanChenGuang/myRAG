"""D-42: how well a private real test set represents production.

`assign` places the gated items of a private set in the tenant's production clusters through the assign-clusters route and writes
`strata.json` (item id, cluster id, language) next to the set; `quotas` lists the clusters whose test share differs from the
30-day production share by more than the tolerance; `weighted_score` and `uncovered_share` give the production-weighted score that
real-set reports show next to the gated, unweighted one (report only). Standard library only; nothing here gates a run.
"""

import argparse
import json
import math
import os
import sys
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from rag_sidecar.contracts.golden import GoldenItem

from rag_eval.draft.writer import PrivatePathError, assert_private_path
from rag_eval.golden_io import load_golden
from rag_eval.golden_set import LifecycleError, load_manifest
from rag_eval.metrics import ACTIVE_STATUS, COVERAGE_ONLY_PROVENANCES
from rag_eval.paths import REPO_ROOT, resolve_cli_path
from rag_eval.review_queue import DEFAULT_TOKEN_ENV, mask_text

EXIT_OK, EXIT_INPUT, EXIT_API, EXIT_PRIVATE = 0, 2, 4, 6

ASSIGN_ROUTE = "/api/rag/admin/monitor/assign-clusters"
GOLDEN_NAME = "golden.jsonl"
STRATA_NAME = "strata.json"
PRODUCTION_SHARES_NAME = "production-shares.json"
QUOTA_REPORT_NAME = "quota-report.json"
GATE_SPLIT = "dev"
GATE_REVIEW_STATUS = "approved"
MAX_ASSIGN_ITEMS = 500
MAX_ASSIGN_QUESTION_CHARS = 2000
DEFAULT_TOLERANCE = 0.10
MONITOR_ALERTS_PATH = REPO_ROOT / "eval" / "config" / "monitor-alerts.json"
SKIP_NOTICE = "::notice::admin base URL or token not configured, skipping cluster assignment"


class RepresentativenessError(Exception):
    pass


def _http_client():
    import httpx

    return httpx.Client(timeout=60.0)


def golden_path(set_path: Path | str) -> Path:
    path = Path(set_path)
    return path / GOLDEN_NAME if path.is_dir() or path.suffix != ".jsonl" else path


def set_dir_of(set_path: Path | str) -> Path:
    return golden_path(set_path).parent


def gate_items(items: Iterable[GoldenItem], statuses: Mapping[str, str] | None = None) -> list[GoldenItem]:
    """The gate population rule (plan 05.3-05): approved, gated split, lifecycle active, provenance not coverage-only."""
    return [
        item
        for item in items
        if item.review_status == GATE_REVIEW_STATUS
        and item.split == GATE_SPLIT
        and item.provenance not in COVERAGE_ONLY_PROVENANCES
        and (statuses is None or statuses.get(item.id, ACTIVE_STATUS) == ACTIVE_STATUS)
    ]


def _statuses(manifest_path: Path | None) -> dict[str, str] | None:
    if manifest_path is None:
        return None
    manifest = load_manifest(manifest_path)
    return {entry.id: entry.status for entry in manifest.items}


def load_gated_set(set_path: Path | str, manifest_path: Path | None = None) -> list[GoldenItem]:
    return gate_items(load_golden(golden_path(set_path)), _statuses(manifest_path))


def _write_json(path: Path, payload: Any) -> None:
    target = assert_private_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_bytes((json.dumps(payload, sort_keys=True, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    os.replace(tmp, target)


def _post_batch(base_url: str, token: str, tenant: str, batch: list[dict[str, str]]) -> dict[str, Any]:
    url = base_url.rstrip("/") + ASSIGN_ROUTE
    try:
        with _http_client() as client:
            response = client.post(url, json={"tenant": tenant, "items": batch}, headers={"Authorization": f"Bearer {token}"})
    except Exception as exc:
        raise RepresentativenessError(f"assign-clusters request failed: {type(exc).__name__}") from None
    if response.status_code != 200:
        raise RepresentativenessError(f"assign-clusters answered HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError:
        raise RepresentativenessError("assign-clusters answered a body that is not JSON") from None
    if not isinstance(payload, dict) or payload.get("success") is not True or not isinstance(payload.get("assignments"), list):
        raise RepresentativenessError("assign-clusters answered without an assignments list")
    return payload


def assign(
    set_dir: Path | str, tenant: str, base_url: str, token: str, manifest_path: Path | None = None
) -> Path:
    """Assign the gated items of a private set to production clusters and write strata.json beside the set."""
    target = assert_private_path(set_dir_of(set_dir) / STRATA_NAME)
    items = load_gated_set(set_dir, manifest_path)
    if not items:
        raise RepresentativenessError("the set has no gated item to assign")
    language_of = {item.id: item.language for item in items}
    requests = [
        {"item_id": item.id, "question": mask_text(item.question)[:MAX_ASSIGN_QUESTION_CHARS].strip() or "-"}
        for item in items
    ]
    cluster_of: dict[str, str] = {}
    set_ids: set[str] = set()
    embedders: set[str] = set()
    for start in range(0, len(requests), MAX_ASSIGN_ITEMS):
        payload = _post_batch(base_url, token, tenant, requests[start : start + MAX_ASSIGN_ITEMS])
        set_ids.add(str(payload.get("set_id", "")))
        embedders.add(str(payload.get("embedder", "")))
        for entry in payload["assignments"]:
            if not isinstance(entry, dict):
                continue
            item_id, cluster_id = entry.get("item_id"), entry.get("cluster_id")
            if isinstance(item_id, str) and isinstance(cluster_id, str) and item_id in language_of:
                cluster_of[item_id] = cluster_id
    if len(set_ids) > 1:
        raise RepresentativenessError("the cluster set changed between batches; run assign again")
    missing = [item.id for item in items if item.id not in cluster_of]
    if missing:
        raise RepresentativenessError(f"assign-clusters left {len(missing)} item(s) unassigned")
    strata = {
        "schema_version": 1,
        "cluster_set_id": next(iter(set_ids)),
        "embedder": next(iter(embedders)),
        "items": [
            {"item_id": item.id, "cluster_id": cluster_of[item.id], "language": language_of[item.id]} for item in items
        ],
    }
    _write_json(target, strata)
    return target


def _strata_items(strata: Mapping[str, Any]) -> list[dict[str, str]]:
    raw = strata.get("items", [])
    if not isinstance(raw, list):
        raise ValueError("strata items must be a list")
    return [entry for entry in raw if isinstance(entry, dict) and isinstance(entry.get("cluster_id"), str)]


def cluster_counts(strata: Mapping[str, Any], item_ids: Iterable[str] | None = None) -> Counter[str]:
    keep = None if item_ids is None else set(item_ids)
    return Counter(
        entry["cluster_id"] for entry in _strata_items(strata) if keep is None or entry.get("item_id") in keep
    )


def cluster_shares(strata: Mapping[str, Any], item_ids: Iterable[str] | None = None) -> dict[str, float]:
    counts = cluster_counts(strata, item_ids)
    total = sum(counts.values())
    return {cluster: count / total for cluster, count in counts.items()} if total else {}


def quotas(
    strata: Mapping[str, Any], production_shares: Mapping[str, float], tolerance: float = DEFAULT_TOLERANCE
) -> list[dict[str, Any]]:
    """Clusters whose test share differs from the production share by more than the tolerance (absolute), by cluster id."""
    counts = cluster_counts(strata)
    shares = cluster_shares(strata)
    gaps: list[dict[str, Any]] = []
    for cluster in sorted(set(production_shares) | set(shares)):
        production = float(production_shares.get(cluster, 0.0))
        test = shares.get(cluster, 0.0)
        delta = test - production
        if abs(delta) > tolerance + 1e-9:
            gaps.append(
                {
                    "cluster_id": cluster,
                    "production_share": production,
                    "test_share": test,
                    "test_items": counts.get(cluster, 0),
                    "delta": delta,
                }
            )
    return gaps


def _cluster_means(item_scores: Mapping[str, float], strata: Mapping[str, Any]) -> dict[str, float]:
    values: dict[str, list[float]] = defaultdict(list)
    for entry in _strata_items(strata):
        score = item_scores.get(entry.get("item_id", ""))
        if score is not None and math.isfinite(score):
            values[entry["cluster_id"]].append(float(score))
    return {cluster: math.fsum(scores) / len(scores) for cluster, scores in values.items() if scores}


def weighted_score(
    item_scores: Mapping[str, float], strata: Mapping[str, Any], production_shares: Mapping[str, float]
) -> float | None:
    """Mean of the per-cluster means, weighted by production share over the clusters that have a scored test item.

    A production cluster without a scored test item is left out here and counted by uncovered_share."""
    means = _cluster_means(item_scores, strata)
    weights = {cluster: float(share) for cluster, share in production_shares.items() if share > 0 and cluster in means}
    total = math.fsum(weights.values())
    if total <= 0:
        return None
    return math.fsum(weights[cluster] * means[cluster] for cluster in weights) / total


def uncovered_share(
    strata: Mapping[str, Any],
    production_shares: Mapping[str, float],
    item_scores: Mapping[str, float] | None = None,
) -> float:
    """The production share of clusters with no test item (with item_scores: no scored test item)."""
    covered = set(_cluster_means(item_scores, strata)) if item_scores is not None else set(cluster_counts(strata))
    total = math.fsum(float(share) for share in production_shares.values() if share > 0)
    if total <= 0:
        return 0.0
    missing = math.fsum(float(share) for cluster, share in production_shares.items() if share > 0 and cluster not in covered)
    return missing / total


def load_strata(path: Path) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path}: strata must be a JSON object")
    _strata_items(payload)
    return payload


def load_production_shares(path: Path) -> dict[str, float]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    shares = payload.get("shares") if isinstance(payload, dict) else None
    if not isinstance(shares, dict):
        raise ValueError(f"{path}: production shares must hold a shares object")
    out: dict[str, float] = {}
    for cluster, share in shares.items():
        value = float(share)
        if not math.isfinite(value) or value < 0 or value > 1:
            raise ValueError(f"{path}: share of {cluster!r} must lie between 0 and 1")
        out[str(cluster)] = value
    return out


def default_tolerance(path: Path = MONITOR_ALERTS_PATH) -> float:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        return float(payload["sampling"]["quota_tolerance"])
    except (OSError, ValueError, KeyError, TypeError):
        return DEFAULT_TOLERANCE


def _cmd_assign(args: argparse.Namespace) -> int:
    set_path = resolve_cli_path(args.set)
    token = os.environ.get(args.token_env, "").strip()
    if not args.base_url or not token:
        print(SKIP_NOTICE)
        return EXIT_OK
    if not golden_path(set_path).is_file():
        print(f"::notice::no private set at {golden_path(set_path).name}, skipping cluster assignment")
        return EXIT_OK
    try:
        manifest = resolve_cli_path(args.manifest) if args.manifest else None
        path = assign(set_path, args.tenant, args.base_url, token, manifest)
    except PrivatePathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_PRIVATE
    except RepresentativenessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_API
    except (OSError, ValueError, LifecycleError) as exc:
        print(f"error: {type(exc).__name__}: could not read the set", file=sys.stderr)
        return EXIT_INPUT
    counts = cluster_counts(load_strata(path))
    print(f"strata written: items={sum(counts.values())} clusters={len(counts)} novel={counts.get('novel', 0)}")
    return EXIT_OK


def _cmd_quotas(args: argparse.Namespace) -> int:
    set_dir = set_dir_of(resolve_cli_path(args.set))
    strata_path = set_dir / STRATA_NAME
    shares_path = resolve_cli_path(args.production_shares) if args.production_shares else set_dir / PRODUCTION_SHARES_NAME
    if not strata_path.is_file() or not shares_path.is_file():
        print("::notice::strata or production shares missing, skipping the quota report")
        return EXIT_OK
    tolerance = args.tolerance if args.tolerance is not None else default_tolerance()
    try:
        strata = load_strata(strata_path)
        production = load_production_shares(shares_path)
        gaps = quotas(strata, production, tolerance)
        _write_json(set_dir / QUOTA_REPORT_NAME, {"schema_version": 1, "tolerance": tolerance, "gaps": gaps})
    except PrivatePathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_PRIVATE
    except (OSError, ValueError) as exc:
        print(f"error: {type(exc).__name__}: could not read strata or production shares", file=sys.stderr)
        return EXIT_INPUT
    print(f"quota gaps: {len(gaps)} cluster(s) outside tolerance {tolerance:.3f}")
    for gap in gaps:
        print(
            f"  {gap['cluster_id']}: production {gap['production_share']:.3f} test {gap['test_share']:.3f} "
            f"items {gap['test_items']}"
        )
    return EXIT_OK


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.representativeness", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    assign_cmd = commands.add_parser("assign", help="assign the private set's gated items to production clusters")
    assign_cmd.add_argument("--set", required=True, help="private set directory (golden.jsonl) or its JSONL file")
    assign_cmd.add_argument("--tenant", required=True)
    assign_cmd.add_argument("--base-url", default=os.environ.get("RAG_APP_BASE_URL", ""))
    assign_cmd.add_argument("--token-env", default=DEFAULT_TOKEN_ENV)
    assign_cmd.add_argument("--manifest", help="golden-set manifest for lifecycle statuses")
    assign_cmd.set_defaults(handler=_cmd_assign)
    quotas_cmd = commands.add_parser("quotas", help="report clusters whose test share is outside the tolerance")
    quotas_cmd.add_argument("--set", required=True)
    quotas_cmd.add_argument("--production-shares", help="defaults to production-shares.json beside the set")
    quotas_cmd.add_argument("--tolerance", type=float, default=None)
    quotas_cmd.set_defaults(handler=_cmd_quotas)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
