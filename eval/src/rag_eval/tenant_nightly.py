"""Tenant nightly drain (Phase 5.3 D-19): answers backfill and re-embed requests with a nightly run on the tenant's set.

`--drain` claims pending requests through the admin route, runs the nightly tier on the tenant's private domain set
against the app and closes each request with counts and failed check names. A tenant without a private set is
closed `skipped` with `no_real_set`. Without the app URL or the admin token the drain prints a notice and exits 0.
Output carries request ids, tenant hashes and counts only.
"""

import argparse
import os
import re
import sys
from pathlib import Path

from rag_sidecar.contracts.cache import TENANT_KEY_PATTERN

from rag_eval.draft import writer
from rag_eval.draft.writer import PrivatePathError, assert_private_path
from rag_eval.nightly_run import NightlyOutcome, run_nightly_tier
from rag_eval.review_queue import (
    DEFAULT_TOKEN_ENV,
    DOMAIN_GOLDEN_NAME,
    DOMAIN_SUBDIR,
    tenant_hash,
)

REQUESTS_ROUTE = "/api/rag/admin/eval-run-requests"
DEFAULT_LIMIT = 5
CLAIM_MAX = 20
REPORTS_SUBDIR = Path("reports") / "tenant-nightly"
NO_REAL_SET = "no_real_set"
EXIT_OK = 0
EXIT_INPUT = 2
NOTICE_CONFIG = (
    "::notice::app URL or {env} not configured, skipping the tenant nightly drain"
)
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

_run_nightly = run_nightly_tier


class _ApiError(Exception):
    """Carries the exception type or HTTP status only; never the token or a body."""


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


def _call(method: str, url: str, token: str, body: dict) -> tuple[int, object]:
    try:
        with _http_client() as client:
            response = client.request(
                method, url, headers={"Authorization": f"Bearer {token}"}, json=body
            )
    except Exception as exc:  # noqa: BLE001 - transport errors never carry the token
        raise _ApiError(type(exc).__name__) from None
    try:
        payload = response.json()
    except ValueError:
        payload = None
    return response.status_code, payload


def claim(base_url: str, token: str, limit: int) -> list[dict[str, str]] | None:
    """Claimed requests with a valid id and tenant key; None when the claim was refused or failed."""
    try:
        status, payload = _call(
            "POST",
            base_url.rstrip("/") + REQUESTS_ROUTE,
            token,
            {"action": "claim", "limit": limit},
        )
    except _ApiError as exc:
        print(f"::notice::tenant nightly claim failed ({exc}), skipping")
        return None
    if status != 200 or not isinstance(payload, dict):
        print(f"::notice::tenant nightly claim answered HTTP {status}, skipping")
        return None
    claimed: list[dict[str, str]] = []
    for row in payload.get("requests") or []:
        if not isinstance(row, dict):
            continue
        request_id, tenant = row.get("id"), row.get("tenant_key")
        if (
            isinstance(request_id, str)
            and _UUID.match(request_id)
            and isinstance(tenant, str)
            and re.fullmatch(TENANT_KEY_PATTERN, tenant)
        ):
            claimed.append({"id": request_id, "tenant_key": tenant})
        else:
            print(
                "[Tenant Nightly] dropped a claimed row with an invalid id or tenant key",
                file=sys.stderr,
            )
    return claimed


def close_body(outcome: NightlyOutcome) -> dict[str, object]:
    """done with pass or fail; skipped with the part's reason; failed with result error when a step broke."""
    results = {part.result for part in outcome.parts}
    if "skipped" in results and "failed" not in results:
        reason = next(part.reason for part in outcome.parts if part.result == "skipped")
        return {"status": "skipped", "skip_reason": reason}
    failed = list(outcome.failed_checks)
    counts = {name: int(value) for name, value in outcome.counts.items()}
    broken = any(
        code in ("internal_error", "harness_failed", "judge_failed") for code in failed
    )
    if broken:
        return {
            "status": "failed",
            "result_summary": {
                "result": "error",
                "failed_checks": failed,
                "counts": counts,
            },
        }
    result = "fail" if "failed" in results else "pass"
    return {
        "status": "done",
        "result_summary": {"result": result, "failed_checks": failed, "counts": counts},
    }


def close(base_url: str, token: str, request_id: str, body: dict[str, object]) -> bool:
    url = f"{base_url.rstrip('/')}{REQUESTS_ROUTE}/{request_id}"
    try:
        status, _ = _call("PATCH", url, token, body)
    except _ApiError as exc:
        print(f"[Tenant Nightly] close {request_id} failed ({exc})", file=sys.stderr)
        return False
    if status != 200:
        print(
            f"[Tenant Nightly] close {request_id} answered HTTP {status}",
            file=sys.stderr,
        )
        return False
    return True


def _private_set(tenant: str) -> tuple[Path, Path]:
    hashed = tenant_hash(tenant)
    golden = assert_private_path(
        writer.PRIVATE_DIR / DOMAIN_SUBDIR / hashed / DOMAIN_GOLDEN_NAME
    )
    return golden, writer.PRIVATE_DIR / REPORTS_SUBDIR / hashed


def drain(base_url: str, token: str, token_env: str, limit: int) -> int:
    claimed = claim(base_url, token, limit)
    if claimed is None:
        return EXIT_OK
    print(f"[Tenant Nightly] claimed {len(claimed)} request(s)")
    for row in claimed:
        request_id, tenant = row["id"], row["tenant_key"]
        hashed = tenant_hash(tenant)
        try:
            golden, reports = _private_set(tenant)
        except PrivatePathError:
            print(
                f"[Tenant Nightly] {request_id} tenant {hashed}: private directory unsafe, left running",
                file=sys.stderr,
            )
            continue
        if not golden.is_file():
            closed = close(
                base_url,
                token,
                request_id,
                {"status": "skipped", "skip_reason": NO_REAL_SET},
            )
            print(
                f"[Tenant Nightly] {request_id} tenant {hashed}: skipped {NO_REAL_SET}"
                + ("" if closed else " (close failed)")
            )
            continue
        try:
            out_dir = assert_private_path(reports / request_id)
        except PrivatePathError:
            print(
                f"[Tenant Nightly] {request_id} tenant {hashed}: private directory unsafe, left running",
                file=sys.stderr,
            )
            continue
        outcome = _run_nightly(
            golden, out_dir, base_url=base_url, exclude_env=[token_env, "GITHUB_TOKEN"]
        )
        body = close_body(outcome)
        closed = close(base_url, token, request_id, body)
        summary = (
            body.get("result_summary")
            if isinstance(body.get("result_summary"), dict)
            else {}
        )
        detail = body.get("skip_reason") or summary.get("result")
        counts = " ".join(
            f"{name}={value}"
            for name, value in sorted((summary.get("counts") or {}).items())
        )
        print(
            f"[Tenant Nightly] {request_id} tenant {hashed}: {body['status']} {detail}"
            + (f" {counts}" if counts else "")
            + ("" if closed else " (close failed)")
        )
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="rag_eval.tenant_nightly",
        description="drain tenant nightly requests (D-19)",
    )
    parser.add_argument(
        "--drain",
        action="store_true",
        required=True,
        help="claim, run and close pending requests",
    )
    parser.add_argument(
        "--base-url",
        default=None,
        help="app URL that serves the admin routes and the RAG answers",
    )
    parser.add_argument(
        "--token-env",
        default=DEFAULT_TOKEN_ENV,
        help="environment variable with an admin access token",
    )
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    args = parser.parse_args(argv)
    if not 1 <= args.limit <= CLAIM_MAX:
        print(f"error: --limit must be between 1 and {CLAIM_MAX}", file=sys.stderr)
        return EXIT_INPUT
    token = os.environ.get(args.token_env, "").strip()
    if not args.base_url or not token:
        print(NOTICE_CONFIG.format(env=args.token_env))
        return EXIT_OK
    return drain(args.base_url, token, args.token_env, args.limit)


if __name__ == "__main__":
    raise SystemExit(main())
