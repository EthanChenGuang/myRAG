"""Release gate (Phase 5.3 D-33 to D-36): the `rag-release-gate` commit status of one commit.

`run` decides a ReleaseGateResult on the checked-out commit, `override` writes an admin's emergency override after a
GitHub permission check, `post` sets the commit status. Skipped is its own result and is posted as failure; only
passed and a verified admin override become success. Output carries ids, hashes, counts and reason codes only.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError
from rag_sidecar.contracts.feedback_loop import ShipCheckResult
from rag_sidecar.contracts.release_gate import (
    GIT_SHA_PATTERN,
    GITHUB_LOGIN_PATTERN,
    ReleaseGateConfig,
    ReleaseGatePart,
    ReleaseGateResult,
)

from rag_eval.config_files import load_gate_population
from rag_eval.nightly_run import NightlyOutcome, run_nightly_tier
from rag_eval.paths import REPO_ROOT, resolve_cli_path

CONFIG_DIR = REPO_ROOT / "eval" / "config"
GATE_FILES: dict[str, Path] = {
    "quality_gates": CONFIG_DIR / "quality-gates.json",
    "release_gate": CONFIG_DIR / "release-gate.json",
    "noise": CONFIG_DIR / "noise.json",
}
RELEASE_GATE_CONFIG = CONFIG_DIR / "release-gate.json"
GATE_POPULATION = CONFIG_DIR / "gate-population.json"
PRIVATE_DOMAIN_DIR = REPO_ROOT / "eval" / "golden" / "private" / "domain"
FIXTURE_GOLDEN = REPO_ROOT / "eval" / "fixtures" / "golden.jsonl"
DEFAULT_OUT = REPO_ROOT / "eval" / "out" / "release-gate"
RESULT_NAME = "release-gate.json"
GITHUB_API = "https://api.github.com"
CONFIG_CHANGES_ROUTE = "/api/rag/admin/config-changes"
DEFAULT_TOKEN_ENV = "GITHUB_TOKEN"
DEFAULT_ADMIN_TOKEN_ENV = "RAG_ADMIN_BEARER"
PR_SMOKE_CHECK = "pr-smoke"
DESCRIPTION_MAX = 100
REASON_MIN = 10
REASON_MAX = 500

EXIT_PASSED = 0
EXIT_NOT_PASSED = 1
EXIT_INPUT = 2
EXIT_NOT_ADMIN = 3
EXIT_API = 4

PRIVATE_DATA_MISSING = "private_data_missing"
PR_SMOKE_NOT_COMPLETED = "pr_smoke_not_completed"
PR_SMOKE_FAILED = "pr_smoke_failed"
SHIP_CHECK_UNAVAILABLE = "ship_check_unavailable"
SHIP_CHECK_FAILED = "ship_check_failed"
SHIP_CHECK_CONFIG_MISMATCH = "ship_check_config_mismatch"
DEFAULTS_UNCHANGED = "defaults_unchanged"
OVERRIDDEN = "overridden"
EFFECTIVE_CONFIG_KEY = "effective_config"
SHIP_CHECK_KEY = "ship_check"
_SHA256 = re.compile(r"^[a-f0-9]{64}$")

_run_nightly = run_nightly_tier


class _ApiError(Exception):
    """Carries the exception type or HTTP status only; never a token or a body."""


def _git_head() -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    return completed.stdout.strip() if completed.returncode == 0 else ""


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _github_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _request(
    method: str,
    url: str,
    *,
    token: str,
    headers: Mapping[str, str] | None = None,
    **kwargs,
) -> tuple[int, object]:
    try:
        with _http_client() as client:
            response = client.request(
                method,
                url,
                headers=dict(headers or {"Authorization": f"Bearer {token}"}),
                **kwargs,
            )
    except Exception as exc:  # noqa: BLE001 - transport errors never carry the token
        raise _ApiError(f"request failed: {type(exc).__name__}") from None
    try:
        body = response.json()
    except ValueError:
        body = None
    return response.status_code, body


def _token(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


# run


def gate_file_hashes() -> dict[str, str]:
    return {
        name: _sha256_file(path) for name, path in GATE_FILES.items() if path.exists()
    }


def changed_gate_files(
    current: Mapping[str, str], previous: ReleaseGateResult | None
) -> list[str]:
    if previous is None:
        return []
    return [
        name
        for name in GATE_FILES
        if name in current
        and previous.gate_file_hashes.get(name) not in (None, current[name])
    ]


def _has_private_data() -> bool:
    return PRIVATE_DOMAIN_DIR.is_dir() and any(
        PRIVATE_DOMAIN_DIR.glob("*/golden.jsonl")
    )


def _read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def ship_check_part(
    *,
    population: str,
    effective_hash: str | None,
    previous: ReleaseGateResult | None,
    ship_result: Path | None,
    ship_candidate: Path | None,
    ship_manifest: Path | None,
) -> tuple[ReleaseGatePart, str | None]:
    """Open Question 3 reading (O-2): a passing ShipCheckResult for the commit's default settings, or defaults unchanged
    since the last released commit that had one. Returns the part and the ship result hash to record."""
    if population != "real":
        return ReleaseGatePart(part="ship_check", result="not_applicable"), None
    if not _has_private_data():
        return ReleaseGatePart(
            part="ship_check", result="skipped", reason=PRIVATE_DATA_MISSING
        ), None
    if effective_hash is None:
        return ReleaseGatePart(
            part="ship_check", result="skipped", reason=SHIP_CHECK_UNAVAILABLE
        ), None
    if ship_result is not None:
        if ship_candidate is None or ship_manifest is None:
            return ReleaseGatePart(
                part="ship_check", result="skipped", reason=SHIP_CHECK_UNAVAILABLE
            ), None
        try:
            ship = ShipCheckResult.model_validate_json(ship_result.read_bytes())
            candidate = _read_json(ship_candidate)
            manifest = _read_json(ship_manifest)
            candidate_hash = _sha256_file(ship_candidate)
            ship_hash = _sha256_file(ship_result)
        except (OSError, ValueError, ValidationError):
            return ReleaseGatePart(
                part="ship_check", result="skipped", reason=SHIP_CHECK_UNAVAILABLE
            ), None
        if not ship.passed or ship.gate_population != "real":
            return ReleaseGatePart(
                part="ship_check", result="failed", reason=SHIP_CHECK_FAILED
            ), ship_hash
        linked = (
            isinstance(candidate, dict)
            and isinstance(manifest, dict)
            and candidate_hash == ship.candidate_hash
            and candidate.get("run_config_hash") == manifest.get("run_config_hash")
            and manifest.get("effective_config_hash") == effective_hash
        )
        if not linked:
            return ReleaseGatePart(
                part="ship_check", result="failed", reason=SHIP_CHECK_CONFIG_MISMATCH
            ), ship_hash
        return ReleaseGatePart(part="ship_check", result="passed"), ship_hash
    if (
        previous is not None
        and previous.result == "passed"
        and previous.source != "override"
    ):
        earlier = next(
            (part for part in previous.parts if part.part == "ship_check"), None
        )
        recorded = previous.report_hashes.get(SHIP_CHECK_KEY)
        if (
            earlier is not None
            and earlier.result == "passed"
            and recorded is not None
            and previous.report_hashes.get(EFFECTIVE_CONFIG_KEY) == effective_hash
        ):
            return ReleaseGatePart(
                part="ship_check", result="passed", reason=DEFAULTS_UNCHANGED
            ), recorded
    return ReleaseGatePart(
        part="ship_check", result="skipped", reason=SHIP_CHECK_UNAVAILABLE
    ), None


def pr_smoke_part(
    sha: str, repo: str | None, token: str | None, api: str = GITHUB_API
) -> ReleaseGatePart:
    """The pr-smoke check run of the exact commit; absent, unfinished or unreadable is skipped, never passed."""
    if not token or not repo:
        return ReleaseGatePart(
            part="pr_smoke", result="skipped", reason=PR_SMOKE_NOT_COMPLETED
        )
    url = f"{api.rstrip('/')}/repos/{repo}/commits/{sha}/check-runs"
    try:
        status, body = _request(
            "GET",
            url,
            token=token,
            headers=_github_headers(token),
            params={"check_name": PR_SMOKE_CHECK},
        )
    except _ApiError as exc:
        print(f"::warning::pr-smoke check runs: {exc}", file=sys.stderr)
        return ReleaseGatePart(
            part="pr_smoke", result="skipped", reason=PR_SMOKE_NOT_COMPLETED
        )
    if status != 200 or not isinstance(body, dict):
        print(f"::warning::pr-smoke check runs answered HTTP {status}", file=sys.stderr)
        return ReleaseGatePart(
            part="pr_smoke", result="skipped", reason=PR_SMOKE_NOT_COMPLETED
        )
    runs = [
        run
        for run in body.get("check_runs") or []
        if isinstance(run, dict) and run.get("status") == "completed"
    ]
    if not runs:
        return ReleaseGatePart(
            part="pr_smoke", result="skipped", reason=PR_SMOKE_NOT_COMPLETED
        )
    latest = max(
        runs,
        key=lambda run: (str(run.get("completed_at") or ""), int(run.get("id") or 0)),
    )
    if latest.get("conclusion") == "success":
        return ReleaseGatePart(part="pr_smoke", result="passed")
    return ReleaseGatePart(part="pr_smoke", result="failed", reason=PR_SMOKE_FAILED)


def _outcome_of(parts: list[ReleaseGatePart]) -> tuple[str, str | None]:
    results = [part.result for part in parts]
    if "failed" in results:
        return "failed", None
    skipped = next((part for part in parts if part.result == "skipped"), None)
    if skipped is not None:
        return "skipped", skipped.reason
    return "passed", None


def build_result(
    *,
    sha: str,
    config: ReleaseGateConfig,
    parts: Mapping[str, ReleaseGatePart],
    source: str,
    gate_hashes: Mapping[str, str],
    changed: list[str],
    report_hashes: Mapping[str, str],
    created_at: str | None = None,
) -> ReleaseGateResult:
    """Keeps the required parts in config order; a required part with no value is skipped, never passed."""
    ordered = [
        parts.get(name)
        or ReleaseGatePart(part=name, result="skipped", reason="part_not_run")
        for name in config.required_parts
    ]
    outcome, skip_reason = _outcome_of(ordered)
    return ReleaseGateResult(
        sha=sha,
        result=outcome,
        skip_reason=skip_reason,
        parts=ordered,
        gate_file_hashes=dict(gate_hashes),
        changed_gate_files=list(changed),
        source=source,
        report_hashes=dict(report_hashes),
        created_at=created_at or _now(),
    )


def _load_previous(path: Path | None) -> ReleaseGateResult | None:
    if path is None:
        return None
    return ReleaseGateResult.model_validate_json(resolve_cli_path(path).read_bytes())


def _report_hashes(outcome: NightlyOutcome) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for name in ("report", "judge", "absolute"):
        path = outcome.report_paths.get(name)
        if path is not None and Path(path).exists():
            hashes[name] = _sha256_file(Path(path))
    if outcome.effective_config_hash and _SHA256.match(outcome.effective_config_hash):
        hashes[EFFECTIVE_CONFIG_KEY] = outcome.effective_config_hash
    return hashes


def _print_result(result: ReleaseGateResult, path: Path) -> None:
    print(
        f"[Release Gate] {result.sha[:12]} {result.result}"
        + (f" ({result.skip_reason})" if result.skip_reason else "")
    )
    for part in result.parts:
        print(
            f"  {part.part}: {part.result}" + (f" {part.reason}" if part.reason else "")
        )
    print(f"[Release Gate] result written to {path}")


def _cmd_run(args: argparse.Namespace) -> int:
    if not re.fullmatch(GIT_SHA_PATTERN, args.sha):
        print("error: --sha must be a full 40-character commit sha", file=sys.stderr)
        return EXIT_INPUT
    if _git_head() != args.sha:
        print(
            "error: the checked-out commit is not --sha; check out the exact commit first",
            file=sys.stderr,
        )
        return EXIT_INPUT
    try:
        config = ReleaseGateConfig.model_validate_json(RELEASE_GATE_CONFIG.read_bytes())
        population, _ = load_gate_population(GATE_POPULATION)
        previous = _load_previous(args.previous)
    except (OSError, ValueError, ValidationError) as exc:
        print(
            f"error: cannot read the gate configuration: {type(exc).__name__}",
            file=sys.stderr,
        )
        return EXIT_INPUT

    out = resolve_cli_path(args.out)
    token = _token(args.token_env)
    outcome = _run_nightly(
        resolve_cli_path(args.golden),
        out / "nightly",
        exclude_env=[args.token_env, DEFAULT_ADMIN_TOKEN_ENV],
    )
    parts: dict[str, ReleaseGatePart] = {part.part: part for part in outcome.parts}
    ship, ship_hash = ship_check_part(
        population=population.mode,
        effective_hash=outcome.effective_config_hash,
        previous=previous,
        ship_result=resolve_cli_path(args.ship_result) if args.ship_result else None,
        ship_candidate=resolve_cli_path(args.ship_candidate)
        if args.ship_candidate
        else None,
        ship_manifest=resolve_cli_path(args.ship_candidate_manifest)
        if args.ship_candidate_manifest
        else None,
    )
    parts["ship_check"] = ship
    parts["pr_smoke"] = pr_smoke_part(args.sha, args.repo, token, args.github_api)

    hashes = gate_file_hashes()
    changed = changed_gate_files(hashes, previous)
    for name in changed:
        print(
            f"::notice::gate file {GATE_FILES[name].name} differs from the previous released commit's result"
        )
    report_hashes = _report_hashes(outcome)
    if ship_hash is not None:
        report_hashes[SHIP_CHECK_KEY] = ship_hash
    result = build_result(
        sha=args.sha,
        config=config,
        parts=parts,
        source=args.source,
        gate_hashes=hashes,
        changed=changed,
        report_hashes=report_hashes,
    )
    path = out / RESULT_NAME
    _write_text(path, result.model_dump_json(indent=2) + "\n")
    _print_result(result, path)
    return EXIT_PASSED if result.result == "passed" else EXIT_NOT_PASSED


# override


def is_admin(repo: str, actor: str, token: str | None, api: str = GITHUB_API) -> bool:
    """D-36: admin permission on the repository; a refused or failed call means not admin."""
    if not token:
        return False
    url = f"{api.rstrip('/')}/repos/{repo}/collaborators/{actor}/permission"
    try:
        status, body = _request("GET", url, token=token, headers=_github_headers(token))
    except _ApiError as exc:
        print(f"error: permission check {exc}", file=sys.stderr)
        return False
    if status != 200 or not isinstance(body, dict):
        print(f"error: permission check answered HTTP {status}", file=sys.stderr)
        return False
    return body.get("permission") == "admin"


def _cmd_override(args: argparse.Namespace) -> int:
    if not re.fullmatch(GIT_SHA_PATTERN, args.sha) or not re.fullmatch(
        GITHUB_LOGIN_PATTERN, args.actor
    ):
        print(
            "error: --sha must be a 40-character sha and --actor a GitHub login",
            file=sys.stderr,
        )
        return EXIT_INPUT
    reason = os.environ.get(args.reason_env, "").strip()
    if not REASON_MIN <= len(reason) <= REASON_MAX:
        print(
            f"error: {args.reason_env} must hold a reason of {REASON_MIN} to {REASON_MAX} characters",
            file=sys.stderr,
        )
        return EXIT_INPUT
    if not args.repo:
        print("error: --repo (or GITHUB_REPOSITORY) is required", file=sys.stderr)
        return EXIT_INPUT
    try:
        config = ReleaseGateConfig.model_validate_json(RELEASE_GATE_CONFIG.read_bytes())
    except (OSError, ValidationError) as exc:
        print(
            f"error: cannot read the gate configuration: {type(exc).__name__}",
            file=sys.stderr,
        )
        return EXIT_INPUT
    if not is_admin(args.repo, args.actor, _token(args.token_env), args.github_api):
        print(
            "error: the override actor has no admin permission on the repository; nothing was written",
            file=sys.stderr,
        )
        return EXIT_NOT_ADMIN
    result = ReleaseGateResult(
        sha=args.sha,
        result="passed",
        parts=[
            ReleaseGatePart(part=name, result="skipped", reason=OVERRIDDEN)
            for name in config.required_parts
        ],
        gate_file_hashes=gate_file_hashes(),
        source="override",
        actor=args.actor,
        override_reason=reason,
        created_at=_now(),
    )
    path = resolve_cli_path(args.out) / RESULT_NAME
    _write_text(path, result.model_dump_json(indent=2) + "\n")
    print(f"[Release Gate] {args.sha[:12]} override by {args.actor} -> {path}")
    return EXIT_PASSED


# post


def _clip(text: str) -> str:
    return text if len(text) <= DESCRIPTION_MAX else text[: DESCRIPTION_MAX - 3] + "..."


def status_for(result: ReleaseGateResult) -> tuple[str, str]:
    """The only place a result becomes a commit status: passed and an admin override are success, all else failure."""
    if result.source == "override" and result.result == "passed" and result.actor:
        return "success", _clip(f"override by {result.actor}")
    if result.source != "override" and result.result == "passed":
        return "success", "passed"
    if result.result == "skipped":
        return "failure", _clip(f"skipped: {result.skip_reason}")
    codes = [
        part.reason or part.part for part in result.parts if part.result == "failed"
    ]
    return "failure", _clip("failed: " + (", ".join(codes) or "unknown"))


_GATE_RESULT = {"passed": "pass", "failed": "fail", "skipped": "skipped"}


def _record_change(
    result: ReleaseGateResult, base_url: str | None, token_env: str, actor: str | None
) -> None:
    """Best effort: GitHub is the record; the app row is added when the URL and admin token are configured (D-34, D-36)."""
    token = _token(token_env)
    if not base_url or not token:
        print(
            f"::notice::app URL or {token_env} not configured, skipping the config change record"
        )
        return
    body: dict[str, object] = {
        "source": "release_override"
        if result.source == "override"
        else "local_prerelease",
        "gate_result": _GATE_RESULT[result.result],
        "release_sha": result.sha,
    }
    login = result.actor if result.source == "override" else actor
    if login and re.fullmatch(GITHUB_LOGIN_PATTERN, login):
        body["github_actor"] = login
    if result.source == "override":
        body["override_reason"] = result.override_reason
    try:
        status, _ = _request(
            "POST", base_url.rstrip("/") + CONFIG_CHANGES_ROUTE, token=token, json=body
        )
    except _ApiError as exc:
        print(f"::warning::config change record {exc}", file=sys.stderr)
        return
    if status != 201:
        print(
            f"::warning::config change record answered HTTP {status}", file=sys.stderr
        )
        return
    print(f"[Release Gate] config change recorded ({body['source']})")


def _cmd_post(args: argparse.Namespace) -> int:
    try:
        result = ReleaseGateResult.model_validate_json(
            resolve_cli_path(args.result).read_bytes()
        )
        config = ReleaseGateConfig.model_validate_json(RELEASE_GATE_CONFIG.read_bytes())
    except (OSError, ValidationError) as exc:
        print(f"error: cannot read the result: {type(exc).__name__}", file=sys.stderr)
        return EXIT_INPUT
    if args.source is not None and args.source != result.source:
        print(
            f"error: --source {args.source} does not match the result's source {result.source}",
            file=sys.stderr,
        )
        return EXIT_INPUT
    token = _token(args.token_env)
    if not token or not args.repo:
        print(
            f"error: set {args.token_env} and --repo (or GITHUB_REPOSITORY) to post the status",
            file=sys.stderr,
        )
        return EXIT_INPUT
    state, description = status_for(result)
    url = f"{args.github_api.rstrip('/')}/repos/{args.repo}/statuses/{result.sha}"
    body = {
        "state": state,
        "context": config.status_context,
        "description": description,
    }
    try:
        status, _ = _request(
            "POST", url, token=token, headers=_github_headers(token), json=body
        )
    except _ApiError as exc:
        print(f"error: status post {exc}", file=sys.stderr)
        return EXIT_API
    if status != 201:
        print(f"error: status post answered HTTP {status}", file=sys.stderr)
        return EXIT_API
    print(
        f"[Release Gate] {result.sha[:12]} {config.status_context}: {state} ({description})"
    )
    if result.source in ("local_prerelease", "override") and (
        args.base_url or result.source == "local_prerelease"
    ):
        _record_change(result, args.base_url, args.admin_token_env, args.actor)
    return EXIT_PASSED


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rag_eval.release_gate",
        description="rag-release-gate commit status (D-33 to D-36)",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    repo_default = os.environ.get("GITHUB_REPOSITORY")

    run = sub.add_parser(
        "run", help="decide the release gate result of the checked-out commit"
    )
    run.add_argument("--sha", required=True)
    run.add_argument("--out", type=Path, default=DEFAULT_OUT)
    run.add_argument(
        "--previous",
        type=Path,
        help="ReleaseGateResult of the previous released commit",
    )
    run.add_argument("--repo", default=repo_default)
    run.add_argument("--token-env", default=DEFAULT_TOKEN_ENV)
    run.add_argument("--source", choices=["ci", "local_prerelease"], default="ci")
    run.add_argument("--golden", type=Path, default=FIXTURE_GOLDEN)
    run.add_argument(
        "--ship-result",
        type=Path,
        help="passing ShipCheckResult for the commit's default settings",
    )
    run.add_argument(
        "--ship-candidate", type=Path, help="candidate EvalReport of that ship check"
    )
    run.add_argument(
        "--ship-candidate-manifest", type=Path, help="run.json of that candidate run"
    )
    run.add_argument("--github-api", default=GITHUB_API)

    override = sub.add_parser(
        "override", help="emergency override by a repository admin (D-36)"
    )
    override.add_argument("--sha", required=True)
    override.add_argument("--actor", required=True)
    override.add_argument(
        "--reason-env", required=True, help="environment variable that holds the reason"
    )
    override.add_argument("--repo", default=repo_default)
    override.add_argument("--token-env", default=DEFAULT_TOKEN_ENV)
    override.add_argument("--out", type=Path, default=DEFAULT_OUT)
    override.add_argument("--github-api", default=GITHUB_API)

    post = sub.add_parser(
        "post", help="set the rag-release-gate commit status from a result"
    )
    post.add_argument("--result", required=True, type=Path)
    post.add_argument("--repo", default=repo_default)
    post.add_argument("--token-env", default=DEFAULT_TOKEN_ENV)
    post.add_argument("--source", choices=["ci", "local_prerelease", "override"])
    post.add_argument("--base-url", help="app URL for the config change record")
    post.add_argument("--admin-token-env", default=DEFAULT_ADMIN_TOKEN_ENV)
    post.add_argument(
        "--actor",
        default=os.environ.get("GITHUB_ACTOR"),
        help="GitHub login recorded with a local prerelease",
    )
    post.add_argument("--github-api", default=GITHUB_API)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "run":
        return _cmd_run(args)
    if args.command == "override":
        return _cmd_override(args)
    return _cmd_post(args)


if __name__ == "__main__":
    raise SystemExit(main())
