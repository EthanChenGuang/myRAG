"""Structural check of the GitHub Actions workflows (pr-smoke, nightly, ray-optional, rag-release-gate).

Run locally with: python3 -I scripts/ci/check-workflows.py
Requires PyYAML. Exits 1 and lists every failed assertion.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
PR = ROOT / ".github" / "workflows" / "pr-smoke.yml"
NIGHTLY = ROOT / ".github" / "workflows" / "nightly.yml"
RAY_OPTIONAL = ROOT / ".github" / "workflows" / "ray-optional.yml"
RELEASE_GATE = ROOT / ".github" / "workflows" / "rag-release-gate.yml"
PROMOTE = ROOT / ".github" / "workflows" / "promote-production.yml"
JUDGE_CALIBRATION_WORKFLOW = ROOT / ".github" / "workflows" / "judge-calibration.yml"
MEASUREMENT = ROOT / "eval" / "reports" / "phase-05.3" / "absolute-gate-measurement.json"
DOCKERFILE = ROOT / "rag-sidecar" / "Dockerfile"
SIDECAR_CONFIG_DIR = ROOT / "rag-sidecar" / "config" / "rag"
SIDECAR_TEST_EXTRAS = ("chunking", "preflight", "hidden-text")

TESTS_DIR = ROOT / "tests"
TSX_GLOB = "tests/*.test.mts"
TSX_COMMAND_RE = re.compile(r"node\s+--import\s+tsx\s+--test\b(?P<args>[^\n]*)")

TS_JOB_NEEDLES = {
    "ts-vitest": ("npx vitest run",),
    "ts-db": ("node --import tsx --test", "tests/rag-db/*.test.mts"),
    "ts-tsx": ("node --import tsx --test", TSX_GLOB, "tests/rag-e2e/*.test.mts", "nullglob"),
    "ts-checks": (
        "node scripts/check-config.mjs",
        "scripts/check-config.test.mjs",
        "scripts/tests/gen-zod.node-test.mjs",
        "npm run typecheck:new",
        "next typegen",
        "npx tsc --noEmit -p tsconfig.json",
        "scripts/tests/tsc-ratchet.node-test.mjs",
        "scripts/tests/check-node-runtime.node-test.mjs",
        "scripts/ci/check-workflows.py",
        "scripts/ci/check-rag-boundary.mjs",
        "scripts/tests/check-rag-boundary.node-test.mjs",
        "scripts/ci/check-language-literals.mjs",
        "scripts/tests/check-language-literals.node-test.mjs",
        "scripts/ci/check-settings-classification.mjs",
        "scripts/tests/check-settings-classification.node-test.mjs",
        "scripts/ci/check-zod-isolation.mjs",
        "scripts/tests/check-zod-isolation.node-test.mjs",
    ),
}
# job -> the shard flag its test command must take from matrix.shard
TS_SHARDED = {"ts-vitest": "--shard=", "ts-db": "--test-shard="}
TS_TIMEOUT_MAX = 25
PR_JOBS = [*TS_JOB_NEEDLES, "sibling-types", "voice-agent", "schema-parity", "python", "eval-smoke", "eval-smoke-p52", "gate-negative-control", "docker-build", "next-build", "pr-smoke"]
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
USES_LINE_RE = re.compile(r"^\s*(?:-\s+)?uses:\s*(?P<ref>\S+)(?P<rest>.*)$")
VERSION_COMMENT_RE = re.compile(r"^\s+#\s*v\d+(\.\d+){0,2}\s*$")
UV_IMAGE_RE = re.compile(r"ghcr\.io/astral-sh/uv:(?P<version>\d+\.\d+\.\d+)")
SKIP_NOTICE = "::notice::judge key not configured, skipping"
ONLINE_SKIP_NOTICE = "::notice::langfuse keys not configured, skipping online judge"
DOCLING_SKIP_NOTICE = "::notice::docling extra not installable, skipping"
SEC_SKIP_NOTICE = "::notice::generator key not configured, skipping injection runs"
WEEKLY_JOB = "weekly-report"
WEEKLY_CRON = "23 4 * * 1"
PRIVATE_FLAG = "HAS_PRIVATE_EVAL"
WEEKLY_SKIP_NOTICE = "::notice::no private eval data on this runner, skipping weekly report"
TENANT_NIGHTLY_JOB = "tenant-nightly"
TENANT_NIGHTLY_SKIP_NOTICE = "::notice::no private eval data or admin token on this runner, skipping tenant nightly"
MONITOR_JOB = "monitor"
JUDGE_CALIBRATION_SKIP_NOTICE = "::notice::judge keys or generator model not configured, skipping judge calibration"
WEEKLY_LIFECYCLE = ("rag_eval.drift", "rag_eval.golden_set stale-scan", "rag_eval.golden_set re-review")
MONITOR_SKIP_NOTICE = "::notice::supabase service-role secrets not configured, skipping monitor"
SEC_SMOKE_STEP = "npm run test-rag -- --run-config eval/config/runs/sec-recommended.json --out eval/out/smoke-sec"
SEC_NIGHTLY_STEP = "run-nightly.mts --sec-matrix --generator live"
P52_SMOKE_STEP = "npm run test-rag -- --phase52 --out eval/out/smoke-p52"
P52_NIGHTLY_STEP = "run-nightly.mts --phase52 --generator live --out eval/out/nightly-p52"
P52_JUDGE_STEP = "rag_eval.judge.run"
P52_SKIP_NOTICE = "::notice::judge key not configured, skipping Phase 5.2 answer-rule runs"
# 05.2-32 (D-12): every generated file the schema-parity job regenerates is in its drift check.
DRIFT_PATHS = (
    "rag-sidecar/schemas",
    "src/lib/rag-eval/contracts.generated.ts",
    "src/lib/rag/lang/texts.generated.ts",
    "tests/fixtures/contracts/samples.json",
)
FRAMEWORKS_STEP = "uv run --directory eval python -m rag_eval.compare frameworks --fixtures"
CACHE_PAIRS_STEP = "npm run test-rag -- --run-config eval/config/runs/query-layer-llamaindex.json --cache-pairs"
CACHE_CHECK_STEP = "python -m rag_eval.calibrate cache --check"
LAKERA_SECRET = "LAKERA_GUARD_API_KEY"
DOCLING_READY = "steps.docling.outputs.ready == 'true'"
RAY_SYNC = "uv sync --directory rag-sidecar --locked --extra ray --extra chunking --extra preflight"
RAY_EQUALITY_TEST = "tests/rag-e2e/backfill-ray-equality.test.mts"
TELEMETRY = {
    "DEEPEVAL_TELEMETRY_OPT_OUT": "1",
    "DEEPEVAL_UPDATE_WARNING_OPT_IN": "0",
    "RAGAS_DO_NOT_TRACK": "true",
}


def load(path: Path) -> tuple[dict, str]:
    text = path.read_text(encoding="utf-8")
    data = yaml.safe_load(text)
    return data, text


def triggers(data: dict) -> dict:
    on = data.get("on", data.get(True))
    if isinstance(on, str):
        return {on: None}
    if isinstance(on, list):
        return {name: None for name in on}
    return on or {}


def uses_refs(data: dict) -> list[str]:
    refs: list[str] = []
    for job in (data.get("jobs") or {}).values():
        if isinstance(job.get("uses"), str):
            refs.append(job["uses"])
        for step in job.get("steps") or []:
            if isinstance(step.get("uses"), str):
                refs.append(step["uses"])
    return refs


def all_steps(job: dict) -> list[dict]:
    return job.get("steps") or []


def step_text(job: dict) -> str:
    parts = []
    for step in all_steps(job):
        parts.append(str(step.get("run", "")))
        parts.append(str(step.get("with", "")))
    return "\n".join(parts)


def check_common(name: str, data: dict, text: str, errors: list[str]) -> None:
    trig = triggers(data)
    if "pull_request_target" in trig or "pull_request_target" in text:
        errors.append(f"{name}: pull_request_target must not be used")
    perms = data.get("permissions")
    if perms != {"contents": "read"}:
        errors.append(f"{name}: top-level permissions must be exactly contents: read, got {perms!r}")
    for ref in uses_refs(data):
        if ref.startswith("./") or ref.startswith("docker://"):
            continue
        if "@" not in ref:
            errors.append(f"{name}: uses '{ref}' has no version pin")
            continue
        version = ref.rsplit("@", 1)[1]
        if not SHA_RE.match(version):
            errors.append(f"{name}: uses '{ref}' must be pinned to a 40-hex commit sha")
    for line in text.splitlines():
        match = USES_LINE_RE.match(line)
        if not match or match.group("ref").startswith(("./", "docker://")):
            continue
        if not VERSION_COMMENT_RE.match(match.group("rest")):
            errors.append(f"{name}: uses '{match.group('ref')}' needs a '# vX.Y.Z' comment naming the pinned release")
    uv_version = dockerfile_uv_version()
    for job in (data.get("jobs") or {}).values():
        for step in all_steps(job):
            if str(step.get("uses", "")).startswith("astral-sh/setup-uv@"):
                pinned = str((step.get("with") or {}).get("version", ""))
                if uv_version is None:
                    errors.append(f"{name}: cannot read the uv version pinned in rag-sidecar/Dockerfile")
                elif pinned != uv_version:
                    errors.append(f"{name}: setup-uv must pin version '{uv_version}' (rag-sidecar/Dockerfile), got {pinned!r}")


def dockerfile_uv_version() -> str | None:
    if not DOCKERFILE.exists():
        return None
    match = UV_IMAGE_RE.search(DOCKERFILE.read_text(encoding="utf-8"))
    return match.group("version") if match else None


def check_tsx_tests_covered(workflows: list[dict], tests_dir: Path, errors: list[str]) -> None:
    files = sorted(p.name for p in tests_dir.glob("*.test.mts"))
    if not files:
        return
    args = ""
    for data in workflows:
        for job in (data.get("jobs") or {}).values():
            for step in all_steps(job):
                for match in TSX_COMMAND_RE.finditer(str(step.get("run", ""))):
                    args += " " + match.group("args")
    tokens = args.split()
    if TSX_GLOB in tokens:
        return
    for name in files:
        if f"tests/{name}" not in tokens:
            errors.append(f"workflows: tests/{name} is not run by any 'node --import tsx --test' step; use the {TSX_GLOB} glob")


AGGREGATE_JOB = "pr-smoke"
TRUNK_BRANCH = "claude/ecstatic-hamilton-86gtwv"
PUSH_BRANCHES = ("main", TRUNK_BRANCH)


def check_pr_aggregate(data: dict, errors: list[str]) -> None:
    """D-37: the aggregate job is the one required check; only real success of every other job satisfies it."""
    name = "pr-smoke"
    push = triggers(data).get("push")
    branches = (push or {}).get("branches") if isinstance(push, dict) else None
    for branch in PUSH_BRANCHES:
        if not isinstance(branches, list) or branch not in branches:
            errors.append(f"{name}: on.push.branches must include '{branch}', got {branches!r}")
    jobs = data.get("jobs") or {}
    job = jobs.get(AGGREGATE_JOB)
    if job is None:
        errors.append(f"{name}: job '{AGGREGATE_JOB}' missing (the one required check, D-37)")
        return
    needs = job.get("needs")
    needs_set = {needs} if isinstance(needs, str) else set(needs or [])
    others = set(jobs) - {AGGREGATE_JOB}
    if needs_set != others:
        missing = sorted(others - needs_set)
        unknown = sorted(needs_set - others)
        errors.append(f"{name}: job '{AGGREGATE_JOB}' needs must list every other job (missing {missing}, unknown {unknown})")
    if str(job.get("if", "")).replace(" ", "") != "always()":
        errors.append(f"{name}: job '{AGGREGATE_JOB}' must run with if: always() so a failed or skipped job is reported")
    if "secrets." in yaml.safe_dump(job):
        errors.append(f"{name}: job '{AGGREGATE_JOB}' must not reference secrets.")
    steps = all_steps(job)
    checker = [
        s
        for s in steps
        if "join(needs.*.result" in str((s.get("env") or {}).get("RESULTS", "")).replace(" ", "")
        and re.search(r'test\s+"\$r"\s+=\s+"success"', str(s.get("run", "")))
    ]
    if not checker:
        errors.append(f"{name}: job '{AGGREGATE_JOB}' needs a step that reads RESULTS from join(needs.*.result, ' ') through env and fails unless every result is success")
    for step in steps:
        run = str(step.get("run", ""))
        if "skipped" in run:
            errors.append(f"{name}: job '{AGGREGATE_JOB}' must not accept a skipped job (found 'skipped' in a run step)")
        if "${{" in run:
            errors.append(f"{name}: job '{AGGREGATE_JOB}' reads results only through env, found '${{{{' in a run step")


def check_pr(errors: list[str]) -> None:
    data, text = load(PR)
    check_common("pr-smoke", data, text, errors)
    trig = triggers(data)
    if "pull_request" not in trig:
        errors.append("pr-smoke: pull_request trigger missing")
    if "secrets." in text:
        errors.append("pr-smoke: must not reference secrets.")
    jobs = data.get("jobs") or {}
    for job in PR_JOBS:
        if job not in jobs:
            errors.append(f"pr-smoke: job '{job}' missing")
    conc = data.get("concurrency") or {}
    if not conc.get("cancel-in-progress"):
        errors.append("pr-smoke: concurrency must cancel in-progress runs")
    node_ok = any(
        str((step.get("with") or {}).get("node-version")) == "22"
        for job in jobs.values()
        for step in all_steps(job)
    )
    if not node_ok:
        errors.append("pr-smoke: node-version '22' not set")
    for jname, job in jobs.items():
        for step in all_steps(job):
            if str(step.get("uses", "")).startswith("actions/setup-node@"):
                pinned = str((step.get("with") or {}).get("node-version"))
                if pinned != "22":
                    errors.append(f"pr-smoke: job {jname} setup-node must use node-version '22', got {pinned!r}")
    py_ok = any(
        str((step.get("with") or {}).get("python-version")) == "3.12"
        for job in jobs.values()
        for step in all_steps(job)
    )
    if not py_ok:
        errors.append("pr-smoke: python-version '3.12' not set")
    neg = jobs.get("gate-negative-control")
    if neg is not None:
        body = step_text(neg)
        if not re.search(r'test\s+"?\$code"?\s+-eq\s+10\b', body):
            errors.append("pr-smoke: gate-negative-control must assert the regression exit code with 'test \"$code\" -eq 10'")
        if not re.search(r"jq -e '[^']*\.offenders \| length > 0[^']*' eval/out/negative/gate\.json", body):
            errors.append("pr-smoke: gate-negative-control must assert offenders in eval/out/negative/gate.json with jq -e")
        if "--max-results 1" not in body:
            errors.append("pr-smoke: gate-negative-control must run with --max-results 1")
        if "--degrade drop_top_candidate" not in body:
            errors.append("pr-smoke: gate-negative-control must run with --degrade drop_top_candidate")
        if "--out eval/out/negative-degrade" not in body:
            errors.append("pr-smoke: gate-negative-control degrade step must write to eval/out/negative-degrade")
        degrade_steps = [
            str(step.get("run", ""))
            for step in all_steps(neg)
            if "--degrade drop_top_candidate" in str(step.get("run", ""))
        ]
        if len(degrade_steps) != 1:
            errors.append("pr-smoke: gate-negative-control must have exactly one --degrade drop_top_candidate step")
        else:
            degrade_body = degrade_steps[0]
            if not re.search(r'test\s+"?\$code"?\s+-eq\s+10\b', degrade_body):
                errors.append("pr-smoke: the degrade step must assert the regression exit code with 'test \"$code\" -eq 10'")
            if not re.search(
                r"jq -e '[^']*\.slice == \"overall\"[^']*\.metric == \"mrr\"[^']*\.threshold - \.observed[^']*>= 0\.05[^']*' eval/out/negative-degrade/gate\.json",
                degrade_body,
            ):
                errors.append("pr-smoke: the degrade step must assert an overall MRR margin >= 0.05 with jq -e on eval/out/negative-degrade/gate.json")
            if not re.search(r"jq -e '[^']*\.passed == false[^']*\.mismatches \| length == 0[^']*' eval/out/negative-degrade/gate\.json", degrade_body):
                errors.append("pr-smoke: the degrade step must assert passed false and no mismatches")
        if body.find("--degrade drop_top_candidate") > body.find("--max-results 1"):
            errors.append("pr-smoke: the degrade step must run before the max_results control")
    check_eval_smoke(jobs.get("eval-smoke"), errors)
    check_eval_smoke_p52(jobs.get("eval-smoke-p52"), errors)
    # every job that runs eval pytest or the harness must sync eval with all extras
    for jname, job in jobs.items():
        body = step_text(job)
        needs_eval = "eval" in body and ("pytest" in body or "test-rag" in body or "vitest" in body)
        if needs_eval and "uv sync --directory eval --locked --all-extras" not in body:
            errors.append(f"pr-smoke: job '{jname}' uses eval but does not sync it with --locked --all-extras")
    check_ts_jobs(jobs, errors)
    for jname, job in jobs.items():
        if re.search(r"tsc-ratchet\.mjs[^\n]*--write", step_text(job)):
            errors.append(f"pr-smoke: job {jname} must not run the tsc ratchet with --write")
    sibling = jobs.get("sibling-types")
    if sibling is not None:
        body = step_text(sibling)
        for needle in (
            "npm ci --ignore-scripts --prefix voice-agent",
            "yarn install --immutable --mode=skip-build",
            "scripts/ci/sibling-tsc-baseline.json --key voice-agent",
            "scripts/ci/sibling-tsc-baseline.json --key baileys-whatsapp",
        ):
            if needle not in body:
                errors.append(f"pr-smoke: job sibling-types is missing '{needle}'")
    voice = jobs.get("voice-agent")
    if voice is not None:
        body = step_text(voice)
        for needle in (
            "npm ci --ignore-scripts",
            "npm test",
            "scripts/ci/sibling-tsc-baseline.json --key voice-agent",
        ):
            if needle not in body:
                errors.append(f"pr-smoke: job voice-agent is missing '{needle}'")
        if not any(
            step.get("working-directory") == "voice-agent" and "npm test" in str(step.get("run", ""))
            for step in all_steps(voice)
        ):
            errors.append("pr-smoke: job voice-agent must run npm test in the voice-agent working directory")
    check_python_job(jobs.get("python"), errors)
    sp = jobs.get("schema-parity")
    if sp is not None:
        body = step_text(sp)
        if "npm run gen:schemas" not in body or "git diff --exit-code" not in body:
            errors.append("pr-smoke: schema-parity must regenerate then git diff --exit-code")
        drift = next((str(step.get("run", "")) for step in all_steps(sp) if "git diff --exit-code" in str(step.get("run", ""))), "")
        for needle in DRIFT_PATHS:
            if needle not in drift:
                errors.append(f"pr-smoke: the schema-parity drift check must include {needle}")
    for jname in (*TS_JOB_NEEDLES, "schema-parity", "eval-smoke", "eval-smoke-p52", "gate-negative-control"):
        job = jobs.get(jname)
        if job is not None and "npm ci" not in step_text(job):
            errors.append(f"pr-smoke: job {jname} must install with npm ci")
    check_next_build(jobs.get("next-build"), errors)
    check_docker_build(jobs.get("docker-build"), errors)
    check_pr_aggregate(data, errors)


def check_python_job(job: dict | None, errors: list[str]) -> None:
    """
    The sidecar tests need the chunking, preflight and hidden-text extras at once. Each `uv sync` and `uv run --extra` installs exactly
    the extras it names and removes the rest, so one sync and the pytest run must both name all three.
    """
    if job is None:
        return
    body = step_text(job)
    syncs = [line for line in body.splitlines() if "uv sync --directory rag-sidecar" in line]
    runs = [line for line in body.splitlines() if "uv run --directory rag-sidecar" in line and "pytest" in line]
    for kind, lines in (("sync", syncs), ("pytest run", runs)):
        if not lines:
            errors.append(f"pr-smoke: job python has no rag-sidecar {kind}")
            continue
        for line in lines:
            if "--locked" not in line:
                errors.append(f"pr-smoke: job python rag-sidecar {kind} must use --locked: {line.strip()}")
            missing = [extra for extra in SIDECAR_TEST_EXTRAS if f"--extra {extra}" not in line]
            if missing:
                errors.append(f"pr-smoke: job python rag-sidecar {kind} must name every test extra (missing {', '.join(missing)}): {line.strip()}")
    if "--extra docling" in body:
        errors.append("pr-smoke: job python must not install the heavy docling extra")
    if "--extra ray" in body:
        errors.append("pr-smoke: job python must not install the ray extra")


def check_docker_build(job: dict | None, errors: list[str]) -> None:
    """The sidecar image must ship every config copy under rag-sidecar/config/rag/, byte-equal to config/rag/."""
    if job is None:
        return
    body = step_text(job)
    for needle in (
        "docker build -t rag-sidecar:ci rag-sidecar",
        "/app/config/rag/",
        "load_routing_config()",
        "load_processing_profiles()",
        "/health",
        "/ready",
        "/v1/info",
        "RAG_SIDECAR_SECRET",
    ):
        if needle not in body:
            errors.append(f"pr-smoke: job docker-build is missing '{needle}'")
    for name in sidecar_config_copies():
        if name not in body:
            errors.append(f"pr-smoke: job docker-build does not compare the image copy of config/rag/{name}")


def sidecar_config_copies() -> list[str]:
    return sorted(p.name for p in SIDECAR_CONFIG_DIR.glob("*.json"))


def check_shards(jname: str, job: dict, flag: str, errors: list[str]) -> None:
    """A sharded job must run every shard k/N for k = 1..N, and its test command must take the shard from the matrix."""
    shards = ((job.get("strategy") or {}).get("matrix") or {}).get("shard")
    if not isinstance(shards, list) or not shards:
        errors.append(f"pr-smoke: job {jname} must list its shards in strategy.matrix.shard")
        return
    values = [str(v) for v in shards]
    total = values[0].split("/")[-1]
    expected = [f"{k}/{total}" for k in range(1, int(total) + 1)] if total.isdigit() and int(total) > 0 else None
    if expected is None or values != expected:
        errors.append(f"pr-smoke: job {jname} matrix.shard must be exactly 1/N..N/N, got {values!r}")
    if f"{flag}${{{{ matrix.shard }}}}" not in step_text(job):
        errors.append(f"pr-smoke: job {jname} must pass {flag}${{{{ matrix.shard }}}} to its test command")


def check_ts_jobs(jobs: dict, errors: list[str]) -> None:
    """The TypeScript checks run as parallel jobs; each one keeps its own required commands."""
    for jname, needles in TS_JOB_NEEDLES.items():
        job = jobs.get(jname)
        if job is None:
            continue
        body = step_text(job)
        for needle in (*needles, "scripts/ci/check-node-runtime.mjs"):
            if needle not in body:
                errors.append(f"pr-smoke: job {jname} is missing '{needle}'")
        if "scripts/ci/tsc-baseline.json" in body or re.search(r"tsc-ratchet\.mjs(?![^\n]*--cwd)", body):
            errors.append(f"pr-smoke: job {jname} must run plain tsc, not the root tsc ratchet or its baseline")
        if "continue-on-error" in str(job):
            errors.append(f"pr-smoke: job {jname} must not use continue-on-error")
        timeout = job.get("timeout-minutes")
        if not isinstance(timeout, int) or timeout > TS_TIMEOUT_MAX:
            errors.append(f"pr-smoke: job {jname} must set timeout-minutes <= {TS_TIMEOUT_MAX}, got {timeout!r}")
        if jname in TS_SHARDED:
            check_shards(jname, job, TS_SHARDED[jname], errors)
        elif (job.get("strategy") or {}).get("matrix"):
            errors.append(f"pr-smoke: job {jname} is not a sharded job and must not use a matrix")


def check_next_build(job: dict | None, errors: list[str]) -> None:
    """The production build Vercel runs: next build must succeed with placeholder env and no secrets."""
    if job is None:
        return
    body = step_text(job)
    if "npm ci" not in body:
        errors.append("pr-smoke: job next-build must install with npm ci")
    if not re.search(r"(?:npx next|npm run) build\b", body):
        errors.append("pr-smoke: job next-build must run 'npx next build'")
    env = {str(k): str(v) for k, v in (job.get("env") or {}).items()}
    for step in all_steps(job):
        env.update({str(k): str(v) for k, v in (step.get("env") or {}).items()})
    for key in ("NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"):
        if key not in env:
            errors.append(f"pr-smoke: job next-build must set {key} to a placeholder")
        elif "placeholder" not in env[key]:
            errors.append(f"pr-smoke: job next-build must use a placeholder value for {key}")
    if "secrets." in str(job):
        errors.append("pr-smoke: job next-build must not reference secrets.")


def check_eval_smoke(job: dict | None, errors: list[str]) -> None:
    if job is None:
        return
    steps = all_steps(job)
    runs = [str(step.get("run", "")) for step in steps]
    plain = next((i for i, run in enumerate(runs) if "npm run test-rag -- --out eval/out/smoke" in run), None)
    ingest = next((i for i, run in enumerate(runs) if "--fixture-mode ingest" in run), None)
    if ingest is None:
        errors.append("pr-smoke: job eval-smoke must run 'npm run test-rag -- --fixture-mode ingest --out eval/out/smoke-ingest'")
        return
    body = runs[ingest]
    if "npm run test-rag -- --fixture-mode ingest --out eval/out/smoke-ingest" not in body:
        errors.append("pr-smoke: the ingest smoke step must run 'npm run test-rag -- --fixture-mode ingest --out eval/out/smoke-ingest'")
    if "--no-gate" in body or "--baseline" in body:
        errors.append("pr-smoke: the ingest smoke step must gate against the committed ingest baseline (no --no-gate, no --baseline)")
    if plain is None or plain > ingest:
        errors.append("pr-smoke: the ingest smoke step must run after the prechunked smoke step")
    uploads = [step for step in steps if str(step.get("uses", "")).startswith("actions/upload-artifact@")]
    if not any("eval/out/smoke-ingest" in str((step.get("with") or {}).get("path", "")) for step in uploads):
        errors.append("pr-smoke: job eval-smoke must upload eval/out/smoke-ingest")
    # D-14, T-05.1-59: the recommended SEC configuration is gated at absolute zero on every pull request.
    sec = next((i for i, run in enumerate(runs) if "sec-recommended.json" in run), None)
    if sec is None:
        errors.append(f"pr-smoke: job eval-smoke must run '{SEC_SMOKE_STEP}'")
    else:
        sec_body = runs[sec]
        if SEC_SMOKE_STEP not in sec_body:
            errors.append(f"pr-smoke: the injection gate step must run '{SEC_SMOKE_STEP}'")
        if "--no-gate" in sec_body or "--baseline" in sec_body or "|| true" in sec_body or "continue-on-error" in str(steps[sec]):
            errors.append("pr-smoke: the injection gate step must gate against the committed baseline and fail the job")
        if plain is None or sec < plain:
            errors.append("pr-smoke: the injection gate step must run after the all-off smoke step, which stays as it is")
    if not any("eval/out/smoke-sec" in str((step.get("with") or {}).get("path", "")) for step in uploads):
        errors.append("pr-smoke: job eval-smoke must upload eval/out/smoke-sec")
    check_query_layer_gates(steps, runs, errors)


def check_eval_smoke_p52(job: dict | None, errors: list[str]) -> None:
    """05.2-32 (D-42, D-54, D-62): the Phase 5.2 tier gates every pull request and fails the job on any gate."""
    if job is None:
        return
    steps = all_steps(job)
    runs = [str(step.get("run", "")) for step in steps]
    tier = [index for index, run in enumerate(runs) if "--phase52" in run]
    if len(tier) != 1 or P52_SMOKE_STEP not in runs[tier[0]]:
        errors.append(f"pr-smoke: job eval-smoke-p52 must run '{P52_SMOKE_STEP}' once")
    else:
        body = runs[tier[0]]
        if "--no-gate" in body or "|| true" in body or "continue-on-error" in str(steps[tier[0]]):
            errors.append("pr-smoke: the Phase 5.2 tier step must gate and fail the job")
    timeout = job.get("timeout-minutes")
    if not isinstance(timeout, int) or timeout > TS_TIMEOUT_MAX:
        errors.append(f"pr-smoke: job eval-smoke-p52 must set timeout-minutes <= {TS_TIMEOUT_MAX}, got {timeout!r}")
    if "python3 scripts/ci/fill-tiktoken-cache.py" not in step_text(job):
        errors.append("pr-smoke: job eval-smoke-p52 must fill the tiktoken cache")
    uploads = [step for step in steps if str(step.get("uses", "")).startswith("actions/upload-artifact@")]
    if not any("eval/out/smoke-p52" in str((step.get("with") or {}).get("path", "")) for step in uploads):
        errors.append("pr-smoke: job eval-smoke-p52 must upload eval/out/smoke-p52")


def check_answer_rules_nightly(data: dict, errors: list[str]) -> None:
    """05.2-32 (D-54): the live Phase 5.2 slices and their judge run nightly behind the judge keys, measured only."""
    job = (data.get("jobs") or {}).get("answer-rules")
    if job is None:
        errors.append("nightly: job 'answer-rules' missing")
        return
    flag = "HAS_JUDGE_KEYS"
    flag_expr = str((job.get("env") or {}).get(flag, ""))
    for secret in ("OPENROUTER_API_KEY", "OPENAI_API_KEY"):
        if f"secrets.{secret} != ''" not in flag_expr:
            errors.append(f"nightly: answer-rules job env {flag} must require secrets.{secret}")
    steps = all_steps(job)
    ungated = [s for s in steps if f"{flag} == 'true'" not in str(s.get("if", ""))]
    if (
        len(ungated) != 1
        or P52_SKIP_NOTICE not in str(ungated[0].get("run", ""))
        or f"{flag} != 'true'" not in str(ungated[0].get("if", ""))
    ):
        errors.append(f"nightly: only the skip-notice step of answer-rules may run without the {flag} == 'true' condition")
    for needle, secrets in ((P52_NIGHTLY_STEP, ("OPENROUTER_API_KEY",)), (P52_JUDGE_STEP, ("OPENROUTER_API_KEY", "OPENAI_API_KEY"))):
        matching = [s for s in steps if needle in str(s.get("run", ""))]
        if len(matching) != 1:
            errors.append(f"nightly: answer-rules must run '{needle}' once")
            continue
        step_env = matching[0].get("env") or {}
        for secret in secrets:
            if str(step_env.get(secret)) != f"${{{{ secrets.{secret} }}}}":
                errors.append(f"nightly: answer-rules must pass {secret} from repository secrets by name through step env")
    if "uv sync --directory eval --locked --all-extras" not in step_text(job):
        errors.append("nightly: answer-rules must sync eval with --locked --all-extras")
    for step in steps:
        run = str(step.get("run", ""))
        if "secrets." in run:
            errors.append("nightly: answer-rules secrets must be passed through step env, not interpolated into run")
        if re.search(r"\becho\b.*\bKEY\b", run):
            errors.append("nightly: an answer-rules step appears to echo a key")


def check_query_layer_gates(steps: list[dict], runs: list[str], errors: list[str]) -> None:
    """D-40, D-42 e, T-06-92: the fixture framework comparison and the cache near-miss gate run on every PR and fail it."""
    installs = [i for i, run in enumerate(runs) if "npm ci" in run or "uv sync --directory eval" in run]
    last_install = max(installs) if installs else None

    def soft(index: int) -> bool:
        return "|| true" in runs[index] or bool(steps[index].get("continue-on-error"))

    def after_installs(index: int, what: str) -> None:
        if last_install is None or index < last_install:
            errors.append(f"pr-smoke: the {what} step must run after npm ci and uv sync")

    frameworks = next((i for i, run in enumerate(runs) if "rag_eval.compare frameworks" in run), None)
    if frameworks is None:
        errors.append(f"pr-smoke: job eval-smoke must run '{FRAMEWORKS_STEP}'")
    else:
        if FRAMEWORKS_STEP not in runs[frameworks]:
            errors.append(f"pr-smoke: the framework comparison step must run '{FRAMEWORKS_STEP}'")
        if soft(frameworks):
            errors.append("pr-smoke: the framework comparison step must fail the job")
        after_installs(frameworks, "framework comparison")

    check = next((i for i, run in enumerate(runs) if CACHE_CHECK_STEP in run), None)
    if check is None:
        errors.append(f"pr-smoke: job eval-smoke must run '{CACHE_CHECK_STEP}' on a fresh pair run")
        return
    if soft(check):
        errors.append("pr-smoke: the cache near-miss gate step must fail the job")
    after_installs(check, "cache near-miss gate")
    lines = runs[check].splitlines()
    check_line = next(n for n, line in enumerate(lines) if CACHE_CHECK_STEP in line)
    pair_line = next((n for n, line in enumerate(lines) if "--cache-pairs" in line), None)
    if pair_line is None:
        errors.append(f"pr-smoke: the cache near-miss gate step must run '{CACHE_PAIRS_STEP}' (--cache-pairs) before the check")
        return
    if pair_line > check_line:
        errors.append(f"pr-smoke: '{CACHE_CHECK_STEP}' must check a fresh pair run, so the --cache-pairs run comes first")
    if CACHE_PAIRS_STEP not in lines[pair_line]:
        errors.append(f"pr-smoke: the cache pair run must be '{CACHE_PAIRS_STEP}'")
    out = re.search(r"--out\s+(\S+)", lines[pair_line])
    if out is None or f"--pairs {out.group(1)}/cache-pairs.json" not in lines[check_line]:
        errors.append("pr-smoke: the cache check must read the cache-pairs.json of the fresh pair run in the same step")


def check_online_judge(data: dict, errors: list[str]) -> None:
    job = (data.get("jobs") or {}).get("online-judge")
    if job is None:
        errors.append("nightly: job 'online-judge' missing")
        return
    flag = "HAS_ONLINE_JUDGE_KEYS"
    if flag not in (job.get("env") or {}):
        errors.append(f"nightly: online-judge job env {flag} missing")
    flag_expr = str((job.get("env") or {}).get(flag, ""))
    for secret in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "OPENROUTER_API_KEY"):
        if f"secrets.{secret} != ''" not in flag_expr:
            errors.append(f"nightly: online-judge gate must require secrets.{secret}")
    body = step_text(job)
    if "uv sync --directory eval --locked --all-extras" not in body:
        errors.append("nightly: online-judge must sync eval with --locked --all-extras")
    if "rag_eval.online_judge" not in body:
        errors.append("nightly: online-judge job is missing 'rag_eval.online_judge'")
    steps = all_steps(job)
    ungated = [s for s in steps if f"{flag} == 'true'" not in str(s.get("if", ""))]
    if (
        len(ungated) != 1
        or ONLINE_SKIP_NOTICE not in str(ungated[0].get("run", ""))
        or f"{flag} != 'true'" not in str(ungated[0].get("if", ""))
    ):
        errors.append(f"nightly: only the skip-notice step of online-judge may run without the {flag} == 'true' condition")
    if len(ungated) == len(steps):
        errors.append(f"nightly: online-judge steps must be conditioned on {flag}")
    runner = next((s for s in steps if "rag_eval.online_judge" in str(s.get("run", ""))), None)
    runner_env = (runner or {}).get("env") or {}
    for secret in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "OPENROUTER_API_KEY"):
        if secret not in runner_env:
            errors.append(f"nightly: online-judge step must receive {secret} through step env")
    if "LANGFUSE_BASE_URL" not in runner_env:
        errors.append("nightly: online-judge step must receive LANGFUSE_BASE_URL through step env")
    for name in ("RAG_APP_URL", "RAG_ADMIN_BEARER"):
        if name not in runner_env:
            errors.append(f"nightly: online-judge step must receive {name} through step env for the score mirror (D-23)")
    if runner is not None and '--base-url "$RAG_APP_URL"' not in str(runner.get("run", "")):
        errors.append('nightly: online-judge must pass --base-url "$RAG_APP_URL" for the score mirror (D-23)')
    for step in steps:
        run = str(step.get("run", ""))
        if "secrets." in run:
            errors.append("nightly: online-judge secrets must be passed through step env, not interpolated into run")
        if re.search(r"\becho\b.*\bKEY\b", run):
            errors.append("nightly: an online-judge step appears to echo a key")


def check_injection_sec(data: dict, errors: list[str]) -> None:
    """D-14, A-13: the live SEC matrix runs nightly behind the generator key; vendor keys only through step env."""
    job = (data.get("jobs") or {}).get("injection-sec")
    if job is None:
        errors.append("nightly: job 'injection-sec' missing")
        return
    flag = "HAS_GENERATOR_KEY"
    flag_expr = str((job.get("env") or {}).get(flag, ""))
    if "secrets.OPENROUTER_API_KEY != ''" not in flag_expr:
        errors.append(f"nightly: injection-sec job env {flag} must require secrets.OPENROUTER_API_KEY")
    steps = all_steps(job)
    ungated = [s for s in steps if f"{flag} == 'true'" not in str(s.get("if", ""))]
    if (
        len(ungated) != 1
        or SEC_SKIP_NOTICE not in str(ungated[0].get("run", ""))
        or f"{flag} != 'true'" not in str(ungated[0].get("if", ""))
    ):
        errors.append(f"nightly: only the skip-notice step of injection-sec may run without the {flag} == 'true' condition")
    runner = [s for s in steps if SEC_NIGHTLY_STEP in str(s.get("run", ""))]
    if len(runner) != 1:
        errors.append(f"nightly: injection-sec must run '{SEC_NIGHTLY_STEP}' once")
    else:
        step_env = runner[0].get("env") or {}
        for secret in ("OPENROUTER_API_KEY", LAKERA_SECRET):
            if str(step_env.get(secret)) != f"${{{{ secrets.{secret} }}}}":
                errors.append(f"nightly: injection-sec must pass {secret} from repository secrets by name through step env")
    if "uv sync --directory eval --locked --all-extras" not in step_text(job):
        errors.append("nightly: injection-sec must sync eval with --locked --all-extras")
    for step in steps:
        run = str(step.get("run", ""))
        if "secrets." in run:
            errors.append("nightly: injection-sec secrets must be passed through step env, not interpolated into run")
        if re.search(r"\becho\b.*\bKEY\b", run):
            errors.append("nightly: an injection-sec step appears to echo a key")


def check_lakera_secret_scope(errors: list[str]) -> None:
    """T-05.1-60: the Lakera key is referenced in nightly.yml only, never in a pull-request or other workflow."""
    workflows_dir = ROOT / ".github" / "workflows"
    for path in sorted(workflows_dir.glob("*.y*ml")):
        if path == NIGHTLY:
            continue
        if LAKERA_SECRET in path.read_text(encoding="utf-8"):
            errors.append(f"{path.name}: {LAKERA_SECRET} may be referenced only in nightly.yml")
    if NIGHTLY.exists() and LAKERA_SECRET not in NIGHTLY.read_text(encoding="utf-8"):
        errors.append(f"nightly: {LAKERA_SECRET} must be passed to the injection-sec job by name")


def check_real_docling(data: dict, errors: list[str]) -> None:
    job = (data.get("jobs") or {}).get("real-docling")
    if job is None:
        errors.append("nightly: job 'real-docling' missing")
        return
    steps = all_steps(job)
    env_text = " ".join(str(step.get("env", "")) for step in steps)
    body = step_text(job) + "\n" + env_text
    needles = (
        "fonts-noto-cjk",
        "uv sync --directory rag-sidecar --locked --extra docling",
        DOCLING_SKIP_NOTICE,
        "uv sync --directory eval --locked --extra fixtures",
        "--target docling",
        'load_profile("general@1")',
        "/opt/docling-models",
        "generate_pdfs.py",
        "--cjk-font",
        "-m real_docling",
        "--extra docling pytest",
        "RAG_SIDECAR_DOCLING_ARTIFACTS",
        "RAG_FIXTURE_PDF_DIR",
        "HF_HUB_OFFLINE",
    )
    for needle in needles:
        if needle not in body:
            errors.append(f"nightly: real-docling job is missing '{needle}'")
    if "secrets." in str(job):
        errors.append("nightly: real-docling needs no secrets and must not reference any")
    sync = next((step for step in steps if step.get("id") == "docling"), None)
    run = str((sync or {}).get("run", ""))
    if sync is None or DOCLING_SKIP_NOTICE not in run or "ready=true" not in run or "ready=false" not in run or "exit 1" in run:
        errors.append("nightly: real-docling must sync the docling extra in a step with id 'docling' that skips with a notice instead of failing")
        return
    for step in steps[steps.index(sync) + 1 :]:
        if DOCLING_READY not in str(step.get("if", "")):
            errors.append(f"nightly: real-docling step '{step.get('name', step.get('uses', '?'))}' must be conditioned on {DOCLING_READY}")


def check_weekly_report(data: dict, errors: list[str]) -> None:
    """D-25, T-0511-74/75: the weekly report runs only where private eval data exists, never uploads it, never inlines a secret."""
    name = "nightly: weekly-report"
    crons = [str(entry.get("cron", "")) for entry in (triggers(data).get("schedule") or []) if isinstance(entry, dict)]
    job = (data.get("jobs") or {}).get(WEEKLY_JOB)
    if job is None:
        errors.append(f"nightly: job '{WEEKLY_JOB}' missing")
        return
    condition = str(job.get("if", ""))
    if (
        WEEKLY_CRON not in crons
        or f"github.event.schedule == '{WEEKLY_CRON}'" not in condition
        or "github.event_name == 'workflow_dispatch'" not in condition
    ):
        errors.append(f"{name} must run only on the weekly schedule '{WEEKLY_CRON}' (listed under schedule) or workflow_dispatch")
    steps = all_steps(job)
    first = steps[0] if steps else {}
    first_run = str(first.get("run", ""))
    if (
        "if" in first
        or "eval/golden/private" not in first_run
        or f"{PRIVATE_FLAG}=true" not in first_run
        or "$GITHUB_ENV" not in first_run
        or WEEKLY_SKIP_NOTICE not in first_run
    ):
        errors.append(
            f"{name}: the first step must run unconditionally, set {PRIVATE_FLAG} in $GITHUB_ENV from the presence of "
            f"eval/golden/private and print '{WEEKLY_SKIP_NOTICE}' when it is absent"
        )
    for step in steps[1:]:
        if f"env.{PRIVATE_FLAG} == 'true'" not in str(step.get("if", "")):
            errors.append(f"{name}: step '{step.get('name', step.get('uses', '?'))}' must be conditioned on env.{PRIVATE_FLAG} == 'true'")
    body = step_text(job)
    for needle in ("rag_eval.failure_report", "rag_eval.weekly_report", "uv sync --directory eval --locked --all-extras", *WEEKLY_LIFECYCLE):
        if needle not in body:
            errors.append(f"{name} is missing '{needle}'")
    report_index = _step_index(steps, "rag_eval.weekly_report")
    for needle in WEEKLY_LIFECYCLE:
        index = _step_index(steps, needle)
        if index is not None and report_index is not None and index > report_index:
            errors.append(f"{name}: the '{needle}' step must run before the weekly report")
    for step in steps:
        uses = str(step.get("uses", ""))
        if uses.startswith("actions/upload-artifact@"):
            errors.append(f"{name} must not upload an artifact (private reports stay on the runner)")
        if uses.startswith("actions/checkout@") and (step.get("with") or {}).get("clean") is not False:
            errors.append(f"{name}: checkout must set clean: false so the gitignored private data stays on the runner")
        run = str(step.get("run", ""))
        if "secrets." in run:
            errors.append(f"{name}: secrets must be passed through step env, not interpolated into run")
        if re.search(r"\becho\b.*\b(KEY|TOKEN|BEARER)\b", run):
            errors.append(f"{name}: a step appears to echo a credential")


def _check_no_leaks(name: str, steps: list[dict], errors: list[str], *, private: bool) -> None:
    for step in steps:
        uses = str(step.get("uses", ""))
        if private and uses.startswith("actions/upload-artifact@"):
            errors.append(f"{name} must not upload an artifact (private data and reports stay on the runner)")
        if private and uses.startswith("actions/checkout@") and (step.get("with") or {}).get("clean") is not False:
            errors.append(f"{name}: checkout must set clean: false so the gitignored private data stays on the runner")
        run = str(step.get("run", ""))
        if "secrets." in run:
            errors.append(f"{name}: secrets must be passed through step env, not interpolated into run")
        if re.search(r"\becho\b.*\b(KEY|TOKEN|BEARER)\b", run):
            errors.append(f"{name}: a step appears to echo a credential")


def _daily_only(job: dict) -> bool:
    return f"github.event.schedule != '{WEEKLY_CRON}'" in str(job.get("if", ""))


def check_tenant_nightly(data: dict, errors: list[str]) -> None:
    """D-19, research X-3: drain tenant nightly requests only where private data and the admin token exist."""
    name = f"nightly: {TENANT_NIGHTLY_JOB}"
    job = (data.get("jobs") or {}).get(TENANT_NIGHTLY_JOB)
    if job is None:
        errors.append(f"nightly: job '{TENANT_NIGHTLY_JOB}' missing")
        return
    if not _daily_only(job):
        errors.append(f"{name} must run on the daily schedule (if: github.event.schedule != '{WEEKLY_CRON}')")
    flag_expr = str((job.get("env") or {}).get("HAS_ADMIN_BEARER", ""))
    if "secrets.RAG_ADMIN_BEARER != ''" not in flag_expr:
        errors.append(f"{name}: job env HAS_ADMIN_BEARER must require secrets.RAG_ADMIN_BEARER")
    steps = all_steps(job)
    first = steps[0] if steps else {}
    first_run = str(first.get("run", ""))
    if (
        "if" in first
        or "eval/golden/private" not in first_run
        or f"{PRIVATE_FLAG}=true" not in first_run
        or "$GITHUB_ENV" not in first_run
        or TENANT_NIGHTLY_SKIP_NOTICE not in first_run
    ):
        errors.append(
            f"{name}: the first step must run unconditionally, set {PRIVATE_FLAG} in $GITHUB_ENV from eval/golden/private "
            f"and print '{TENANT_NIGHTLY_SKIP_NOTICE}' otherwise"
        )
    if '"$HAS_ADMIN_BEARER" = "true"' not in first_run:
        errors.append(f"{name}: the first step must set {PRIVATE_FLAG} only when HAS_ADMIN_BEARER is true")
    for step in steps[1:]:
        if f"env.{PRIVATE_FLAG} == 'true'" not in str(step.get("if", "")):
            errors.append(f"{name}: step '{step.get('name', step.get('uses', '?'))}' must be conditioned on env.{PRIVATE_FLAG} == 'true'")
    drain = next((s for s in steps if "rag_eval.tenant_nightly" in str(s.get("run", ""))), None)
    if drain is None or "--drain" not in str(drain.get("run", "")) or "--base-url" not in str(drain.get("run", "")):
        errors.append(f"{name} must run 'python -m rag_eval.tenant_nightly --drain --base-url'")
    elif "RAG_ADMIN_BEARER" not in (drain.get("env") or {}):
        errors.append(f"{name}: the drain must receive RAG_ADMIN_BEARER through step env")
    _check_no_leaks(name, steps, errors, private=True)


def check_monitor_job(data: dict, errors: list[str]) -> None:
    """O-2, D-20: the daily rule evaluation runs only with the Supabase URL and service-role key as repository secrets."""
    name = f"nightly: {MONITOR_JOB}"
    flag = "HAS_MONITOR_SECRETS"
    job = (data.get("jobs") or {}).get(MONITOR_JOB)
    if job is None:
        errors.append(f"nightly: job '{MONITOR_JOB}' missing")
        return
    if not _daily_only(job):
        errors.append(f"{name} must run on the daily schedule (if: github.event.schedule != '{WEEKLY_CRON}')")
    flag_expr = str((job.get("env") or {}).get(flag, ""))
    for secret in ("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if f"secrets.{secret} != ''" not in flag_expr:
            errors.append(f"{name}: job env {flag} must require secrets.{secret}")
    steps = all_steps(job)
    ungated = [s for s in steps if f"{flag} == 'true'" not in str(s.get("if", ""))]
    if (
        len(ungated) != 1
        or MONITOR_SKIP_NOTICE not in str(ungated[0].get("run", ""))
        or f"{flag} != 'true'" not in str(ungated[0].get("if", ""))
    ):
        errors.append(f"{name}: only the skip-notice step may run without the {flag} == 'true' condition")
    runner = next((s for s in steps if "npm run rag:monitor" in str(s.get("run", ""))), None)
    if runner is None:
        errors.append(f"{name} must run 'npm run rag:monitor'")
    else:
        runner_env = runner.get("env") or {}
        for secret in ("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
            if secret not in runner_env:
                errors.append(f"{name}: the monitor step must receive {secret} through step env")
    if "npm ci --ignore-scripts" not in step_text(job):
        errors.append(f"{name} must install with npm ci --ignore-scripts")
    for step in steps:
        if str(step.get("uses", "")).startswith("actions/upload-artifact@"):
            errors.append(f"{name} must not upload an artifact")
    _check_no_leaks(name, steps, errors, private=False)


JUDGE_CALIBRATION_FLAG = "HAS_JUDGE_KEYS"
JUDGE_CALIBRATION_SEED_RUN = "python -m rag_eval.judge_calibration run --seed-only"
_PUSH_OR_PR_RE = re.compile(r"\bgit\s+push\b|\bgh\s+pr\b|\bgh\s+api\b.*\bpulls\b")


def check_judge_calibration(data: dict, errors: list[str]) -> None:
    """D-32: monthly calibration with a visible skip; the result is an artifact, a person opens the pull request."""
    name = "judge-calibration"
    trig = triggers(data)
    schedule = trig.get("schedule") or []
    if not any(isinstance(entry, dict) and entry.get("cron") for entry in schedule):
        errors.append(f"{name}: a monthly schedule is required")
    if "workflow_dispatch" not in trig:
        errors.append(f"{name}: trigger 'workflow_dispatch' missing")
    for forbidden in ("pull_request", "pull_request_target", "push"):
        if forbidden in trig:
            errors.append(f"{name}: trigger '{forbidden}' must not be used")
    if data.get("permissions") != {"contents": "read"}:
        errors.append(f"{name}: top-level permissions must be exactly contents: read (no write permission)")
    env = data.get("env") or {}
    for key, value in TELEMETRY.items():
        if str(env.get(key)) != value:
            errors.append(f"{name}: workflow env {key} must be '{value}'")
    jobs = data.get("jobs") or {}
    if not jobs:
        errors.append(f"{name}: no job")
    for jname, job in jobs.items():
        for scope, level in (job.get("permissions") or {}).items():
            if str(level) == "write":
                errors.append(f"{name}: job {jname} must not request {scope}: write")
        flag_expr = str((job.get("env") or {}).get(JUDGE_CALIBRATION_FLAG, ""))
        for secret in ("OPENROUTER_API_KEY", "OPENAI_API_KEY"):
            if f"secrets.{secret} != ''" not in flag_expr:
                errors.append(f"{name}: job env {JUDGE_CALIBRATION_FLAG} must require secrets.{secret}")
        steps = all_steps(job)
        ungated = [s for s in steps if f"{JUDGE_CALIBRATION_FLAG} == 'true'" not in str(s.get("if", ""))]
        if (
            len(ungated) != 1
            or JUDGE_CALIBRATION_SKIP_NOTICE not in str(ungated[0].get("run", ""))
            or f"{JUDGE_CALIBRATION_FLAG} != 'true'" not in str(ungated[0].get("if", ""))
        ):
            errors.append(f"{name}: only the skip-notice step may run without the {JUDGE_CALIBRATION_FLAG} == 'true' condition")
        if JUDGE_CALIBRATION_SEED_RUN not in " ".join(step_text(job).split()):
            errors.append(f"{name} must run '{JUDGE_CALIBRATION_SEED_RUN}'")
        uploads = [s for s in steps if str(s.get("uses", "")).startswith("actions/upload-artifact@")]
        if not any(JUDGE_CALIBRATION in str((s.get("with") or {}).get("path", "")) for s in uploads):
            errors.append(f"{name} must upload {JUDGE_CALIBRATION} as an artifact for a person to open the pull request")
        for step in uploads:
            if "eval/golden/private" in str((step.get("with") or {}).get("path", "")):
                errors.append(f"{name} must not upload anything under eval/golden/private")
        for step in steps:
            run = str(step.get("run", ""))
            if _PUSH_OR_PR_RE.search(run):
                errors.append(f"{name} must not push a branch or open a pull request (a person opens it from the artifact)")
        _check_no_leaks(name, steps, errors, private=False)


def check_nightly_triggers(data: dict, errors: list[str]) -> None:
    trig = triggers(data)
    for t in ("schedule", "workflow_dispatch"):
        if t not in trig:
            errors.append(f"nightly: trigger '{t}' missing")
    for forbidden in ("pull_request", "push"):
        if forbidden in trig:
            errors.append(f"nightly: trigger '{forbidden}' must not be used (secrets must never reach fork code)")


def check_nightly(errors: list[str]) -> None:
    data, text = load(NIGHTLY)
    check_common("nightly", data, text, errors)
    check_nightly_triggers(data, errors)
    env = data.get("env") or {}
    for key, value in TELEMETRY.items():
        if str(env.get(key)) != value:
            errors.append(f"nightly: workflow env {key} must be '{value}'")
    if SKIP_NOTICE not in text:
        errors.append("nightly: skip notice missing")
    if "CONFIDENT_API_KEY" in text:
        errors.append("nightly: CONFIDENT_API_KEY must never be set")
    check_online_judge(data, errors)
    check_real_docling(data, errors)
    check_injection_sec(data, errors)
    check_answer_rules_nightly(data, errors)
    check_weekly_report(data, errors)
    check_tenant_nightly(data, errors)
    check_monitor_job(data, errors)
    job = (data.get("jobs") or {}).get("judge")
    if job is None:
        errors.append("nightly: job 'judge' missing")
        return
    body = step_text(job)
    if "uv sync --directory eval --locked --all-extras" not in body:
        errors.append("nightly: must sync eval with --locked --all-extras")
    for needle in ("run-nightly.mts --generator live", "rag_eval.judge.run"):
        if needle not in body:
            errors.append(f"nightly: judge job is missing '{needle}'")
    steps = all_steps(job)
    gated = [s for s in steps if "HAS_JUDGE_KEYS == 'true'" in str(s.get("if", ""))]
    ungated = [s for s in steps if "HAS_JUDGE_KEYS == 'true'" not in str(s.get("if", ""))]
    if (
        len(ungated) != 1
        or SKIP_NOTICE not in str(ungated[0].get("run", ""))
        or "HAS_JUDGE_KEYS != 'true'" not in str(ungated[0].get("if", ""))
    ):
        errors.append("nightly: only the skip-notice step may run without the HAS_JUDGE_KEYS == 'true' condition")
    if "HAS_JUDGE_KEYS" not in str((job.get("env") or {}).keys()):
        errors.append("nightly: job env HAS_JUDGE_KEYS missing")
    if not gated:
        errors.append("nightly: remaining steps must be conditioned on HAS_JUDGE_KEYS")
    # secrets only as step env, never inside run scripts
    for step in steps:
        if "secrets." in str(step.get("run", "")):
            errors.append("nightly: secrets must be passed through step env, not interpolated into run")
        if re.search(r"\becho\b.*\bKEY\b", str(step.get("run", ""))) and SKIP_NOTICE not in str(step.get("run", "")):
            errors.append("nightly: a step appears to echo a key")


def check_ray_optional(data: dict, text: str, errors: list[str]) -> None:
    """The optional Ray job (D-37): scheduled or manual only, no secrets, the ray extra synced from the lock, both Ray tests run."""
    name = "ray-optional"
    check_common(name, data, text, errors)
    trig = triggers(data)
    for t in ("schedule", "workflow_dispatch"):
        if t not in trig:
            errors.append(f"{name}: trigger '{t}' missing")
    for forbidden in ("pull_request", "push"):
        if forbidden in trig:
            errors.append(f"{name}: trigger '{forbidden}' must not be used (the PR pipeline never installs the ray extra)")
    if "secrets." in text:
        errors.append(f"{name}: must not reference secrets.")
    jobs = data.get("jobs") or {}
    if not jobs:
        errors.append(f"{name}: no job")
        return
    body = "\n".join(step_text(job) for job in jobs.values())
    for needle in (RAY_SYNC, "npm ci", "-m ray", "tests/test_ingest_ray_runner.py", RAY_EQUALITY_TEST):
        if needle not in body:
            errors.append(f"{name}: missing '{needle}'")
    if "--extra docling" in body:
        errors.append(f"{name}: must not install the heavy docling extra")
    for job in jobs.values():
        for step in all_steps(job):
            if RAY_EQUALITY_TEST in str(step.get("run", "")):
                step_env = {**(job.get("env") or {}), **(step.get("env") or {})}
                if str(step_env.get("RAG_TEST_RAY")) != "1":
                    errors.append(f"{name}: the equality step must set RAG_TEST_RAY to '1', or the test skips")


def check_no_ray_extra(name: str, text: str, errors: list[str]) -> None:
    if "--extra ray" in text:
        errors.append(f"{name}: must not install the ray extra (it runs only in ray-optional.yml)")


RELEASE_GATE_CONTEXT = "rag-release-gate"
RELEASE_GATE_JOB = "gate"
RELEASE_GATE_JOB_PERMISSIONS = {"contents": "read", "statuses": "write", "checks": "read"}
RELEASE_GATE_RUN = "python -m rag_eval.release_gate run"
RELEASE_GATE_OVERRIDE = "python -m rag_eval.release_gate override"
RELEASE_GATE_POSTER = "node scripts/ci/post-release-status.mjs"
RELEASE_GATE_SHA_PATTERN = "^[0-9a-f]{40}$"


def _step_index(steps: list[dict], needle: str) -> int | None:
    return next((i for i, step in enumerate(steps) if needle in str(step.get("run", ""))), None)


def check_release_gate(data: dict, text: str, errors: list[str], known_refs: set[str] | None = None) -> None:
    """D-33, D-36, research F-3: the rag-release-gate commit status is posted by job `gate` on the exact commit."""
    name = "rag-release-gate"
    check_common(name, data, text, errors)
    trig = triggers(data)
    for forbidden in ("pull_request", "pull_request_target", "schedule", "workflow_run"):
        if forbidden in trig:
            errors.append(f"{name}: trigger '{forbidden}' must not be used")
    dispatch = trig.get("workflow_dispatch") if "workflow_dispatch" in trig else None
    inputs = (dispatch or {}).get("inputs") or {}
    if "workflow_dispatch" not in trig:
        errors.append(f"{name}: trigger 'workflow_dispatch' missing")
    if not (inputs.get("sha") or {}).get("required"):
        errors.append(f"{name}: workflow_dispatch needs a required 'sha' input")
    if "override_reason" not in inputs or (inputs.get("override_reason") or {}).get("required"):
        errors.append(f"{name}: workflow_dispatch needs an optional 'override_reason' input")
    extra = sorted(set(inputs) - {"sha", "override_reason"})
    if extra:
        errors.append(f"{name}: unexpected workflow_dispatch inputs {extra}")
    push = trig.get("push") if "push" in trig else None
    if "push" not in trig or not isinstance(push, dict) or push.get("branches") != ["main"] or set(push) != {"branches"}:
        errors.append(f"{name}: push must trigger on branches [main] only, got {push!r}")
    concurrency = data.get("concurrency") or {}
    if not isinstance(concurrency, dict) or concurrency.get("cancel-in-progress") is not False or "sha" not in str(concurrency.get("group", "")):
        errors.append(f"{name}: concurrency must be grouped per sha with cancel-in-progress false")

    jobs = data.get("jobs") or {}
    for jname, job in jobs.items():
        if jname == RELEASE_GATE_CONTEXT or str((job or {}).get("name", "")) == RELEASE_GATE_CONTEXT:
            errors.append(f"{name}: no job may be named {RELEASE_GATE_CONTEXT} (a check run would shadow the commit status)")
        perms = (job or {}).get("permissions")
        if jname != RELEASE_GATE_JOB and isinstance(perms, dict) and any(v == "write" for v in perms.values()):
            errors.append(f"{name}: only job '{RELEASE_GATE_JOB}' may hold a write permission")
    job = jobs.get(RELEASE_GATE_JOB)
    if job is None:
        errors.append(f"{name}: job '{RELEASE_GATE_JOB}' missing")
        return
    if job.get("permissions") != RELEASE_GATE_JOB_PERMISSIONS:
        errors.append(f"{name}: job '{RELEASE_GATE_JOB}' permissions must be exactly {RELEASE_GATE_JOB_PERMISSIONS}, got {job.get('permissions')!r}")
    env = job.get("env") or {}
    if "inputs.sha" not in str(env.get("GATE_SHA", "")) or "github.sha" not in str(env.get("GATE_SHA", "")):
        errors.append(f"{name}: job env GATE_SHA must come from inputs.sha or github.sha")
    flag = str(env.get("HAS_JUDGE_KEYS", ""))
    for secret in ("OPENROUTER_API_KEY", "OPENAI_API_KEY"):
        if f"secrets.{secret} != ''" not in flag:
            errors.append(f"{name}: job env HAS_JUDGE_KEYS must require secrets.{secret}")

    steps = all_steps(job)
    for step in steps:
        run = str(step.get("run", ""))
        if "${{" in run:
            errors.append(f"{name}: inputs, secrets and contexts reach run scripts only through env, found '${{{{' in a run step")
        if "secrets." in run or "inputs." in run:
            errors.append(f"{name}: inputs and secrets must be passed through step env, not interpolated into run")
        if re.search(r"\becho\b.*\b(KEY|TOKEN|BEARER)\b", run):
            errors.append(f"{name}: a step appears to echo a secret")
    if known_refs is not None:
        for ref in uses_refs(data):
            if ref not in known_refs:
                errors.append(f"{name}: uses '{ref}' is not a pinned action already used by pr-smoke or nightly")

    validate = next((i for i, s in enumerate(steps) if RELEASE_GATE_SHA_PATTERN in str(s.get("run", "")) and "GATE_SHA" in str(s.get("run", ""))), None)
    if validate != 0:
        errors.append(f"{name}: the first step must check GATE_SHA against {RELEASE_GATE_SHA_PATTERN}")
    pending = next(
        (
            i
            for i, s in enumerate(steps)
            if "state=pending" in str(s.get("run", "")) and RELEASE_GATE_CONTEXT in str(s.get("run", "")) and "/statuses/" in str(s.get("run", ""))
        ),
        None,
    )
    gate = _step_index(steps, RELEASE_GATE_RUN)
    override = _step_index(steps, RELEASE_GATE_OVERRIDE)
    poster = _step_index(steps, RELEASE_GATE_POSTER)
    checkout = next((i for i, s in enumerate(steps) if str(s.get("uses", "")).startswith("actions/checkout@")), None)
    if gate is None:
        errors.append(f"{name}: no step runs '{RELEASE_GATE_RUN}'")
    if override is None:
        errors.append(f"{name}: no step runs '{RELEASE_GATE_OVERRIDE}'")
    if pending is None or any(i is not None and pending > i for i in (gate, override)):
        errors.append(f"{name}: a pending {RELEASE_GATE_CONTEXT} status must be posted before the gate and override steps")
    if checkout is None or str((steps[checkout].get("with") or {}).get("ref", "")).replace(" ", "") != "${{env.GATE_SHA}}":
        errors.append(f"{name}: checkout must check out ref ${{{{ env.GATE_SHA }}}}")
    elif any(i is not None and checkout > i for i in (gate, override)):
        errors.append(f"{name}: checkout must come before the gate and override steps")
    if poster is None:
        errors.append(f"{name}: no step runs '{RELEASE_GATE_POSTER}'")
    else:
        if not str(steps[poster].get("if", "")).replace(" ", "").startswith("always()"):
            errors.append(f"{name}: the status posting step must run with if: always()")
        if any(i is not None and poster < i for i in (gate, override)):
            errors.append(f"{name}: the status posting step must come after the gate and override steps")
        if "GH_TOKEN" not in (steps[poster].get("env") or {}):
            errors.append(f"{name}: the status posting step must receive GH_TOKEN through step env")
    if gate is not None:
        gate_env = steps[gate].get("env") or {}
        for secret in ("OPENROUTER_API_KEY", "OPENAI_API_KEY"):
            if secret not in gate_env:
                errors.append(f"{name}: the gate step must receive {secret} through step env")
        if "override_reason == ''" not in str(steps[gate].get("if", "")):
            errors.append(f"{name}: the gate step must run only without an override reason")
    if override is not None:
        ostep = steps[override]
        oenv = ostep.get("env") or {}
        orun = str(ostep.get("run", ""))
        if str(oenv.get("TRIGGERING_ACTOR", "")).replace(" ", "") != "${{github.triggering_actor}}":
            errors.append(f"{name}: the override step must take TRIGGERING_ACTOR from github.triggering_actor through env")
        if "inputs.override_reason" not in str(oenv.get("OVERRIDE_REASON", "")) or "--reason-env OVERRIDE_REASON" not in orun:
            errors.append(f"{name}: the override reason must reach the override step through env OVERRIDE_REASON and --reason-env")
        if '--actor "$TRIGGERING_ACTOR"' not in orun:
            errors.append(f"{name}: the override step must pass --actor \"$TRIGGERING_ACTOR\"")
        if "override_reason != ''" not in str(ostep.get("if", "")):
            errors.append(f"{name}: the override step must run only with an override reason")


PROMOTE_JOB_PERMISSIONS = {"contents": "read", "statuses": "read"}
PROMOTE_RUN = 'node scripts/ci/promote-production.mjs --sha "$PROMOTE_SHA"'


def check_promote_production(data: dict, text: str, errors: list[str], known_refs: set[str] | None = None) -> None:
    """D-35, O-5: manual promotion of a staged production build, only after a passed rag-release-gate."""
    name = "promote-production"
    check_common(name, data, text, errors)
    trig = triggers(data)
    if set(trig) != {"workflow_dispatch"}:
        errors.append(f"{name}: must trigger on workflow_dispatch only, got {sorted(map(str, trig))}")
    inputs = ((trig.get("workflow_dispatch") or {}).get("inputs") or {}) if isinstance(trig.get("workflow_dispatch"), dict) else {}
    if not (inputs.get("sha") or {}).get("required"):
        errors.append(f"{name}: workflow_dispatch needs a required 'sha' input")
    extra = sorted(set(inputs) - {"sha"})
    if extra:
        errors.append(f"{name}: unexpected workflow_dispatch inputs {extra}")
    concurrency = data.get("concurrency") or {}
    if not isinstance(concurrency, dict) or concurrency.get("cancel-in-progress") is not False or not concurrency.get("group"):
        errors.append(f"{name}: concurrency must be grouped with cancel-in-progress false")
    if known_refs is not None:
        for ref in uses_refs(data):
            if ref not in known_refs:
                errors.append(f"{name}: uses '{ref}' is not a pinned action already used by pr-smoke or nightly")
    jobs = data.get("jobs") or {}
    if len(jobs) != 1:
        errors.append(f"{name}: exactly one job expected, got {sorted(jobs)}")
    promote_steps = []
    for jname, job in jobs.items():
        job = job or {}
        if job.get("permissions") != PROMOTE_JOB_PERMISSIONS:
            errors.append(f"{name}: job '{jname}' permissions must be exactly {PROMOTE_JOB_PERMISSIONS}, got {job.get('permissions')!r}")
        for step in all_steps(job):
            run = str(step.get("run", ""))
            if "${{" in run:
                errors.append(f"{name}: inputs, secrets and contexts reach run scripts only through env, found '${{{{' in a run step")
            if "secrets." in run or "inputs." in run:
                errors.append(f"{name}: inputs and secrets must be passed through step env, not interpolated into run")
            if re.search(r"\becho\b.*\b(KEY|TOKEN|BEARER)\b", run):
                errors.append(f"{name}: a step appears to echo a secret")
            if str(step.get("uses", "")).startswith("actions/checkout@") and "ref" in (step.get("with") or {}):
                errors.append(f"{name}: checkout must not check out the promoted sha; the script runs from the default branch")
            if PROMOTE_RUN in run:
                promote_steps.append(step)
    if len(promote_steps) != 1:
        errors.append(f"{name}: no step runs '{PROMOTE_RUN}' (exactly one expected)")
        return
    env = promote_steps[0].get("env") or {}
    expected = {
        "PROMOTE_SHA": "${{inputs.sha}}",
        "GH_TOKEN": "${{github.token}}",
        "VERCEL_TOKEN": "${{secrets.VERCEL_TOKEN}}",
        "VERCEL_PROJECT_ID": "${{secrets.VERCEL_PROJECT_ID}}",
        "VERCEL_TEAM_ID": "${{secrets.VERCEL_TEAM_ID}}",
    }
    for key, value in expected.items():
        if str(env.get(key, "")).replace(" ", "") != value:
            errors.append(f"{name}: the promote step must receive {key} through step env as {value}")


QUALITY_GATES = "eval/config/quality-gates.json"
PROMPT_CONTROL_OVERLAY = "eval/fixtures/controls/no-refusal-directive.overlay.json"
FIXTURE_MANIFESTS = ("eval/fixtures/golden.manifest.json", "eval/fixtures/ingest/golden-ingest.manifest.json")
JUDGE_CALIBRATION = "eval/config/judge-calibration.json"
STAGE_ORDER = {"before": 0, "after": 1}
SMOKE_COMMAND_RE = re.compile(r"npm run test-rag\b(?P<args>[^\n]*)")
OUT_RE = re.compile(r"--out\s+(\S+)")
GATES_FILE_RE = re.compile(r"--gates\s+(\S+)")


def latest_tier_modes(measurement_path: Path = MEASUREMENT) -> dict[str, str]:
    """The mode of each measured tier's latest stage, keyed by its --out directory (05.3-15 measurement record)."""
    data = json.loads(measurement_path.read_text(encoding="utf-8"))
    latest: dict[str, tuple[int, dict]] = {}
    for entry in data.get("tiers") or []:
        name = str(entry.get("name"))
        rank = STAGE_ORDER.get(str(entry.get("stage")), -1)
        if name not in latest or rank > latest[name][0]:
            latest[name] = (rank, entry)
    return {str(entry["out"]): str(entry.get("mode") or "") for _, entry in latest.values() if entry.get("out")}


def report_only_outs(measurement_path: Path = MEASUREMENT) -> set[str]:
    return {out for out, mode in latest_tier_modes(measurement_path).items() if mode == "report"}


def check_smoke_gate_flags(job_name: str, job: dict, report_outs: set[str], errors: list[str]) -> None:
    for step in all_steps(job):
        for match in SMOKE_COMMAND_RE.finditer(str(step.get("run", ""))):
            args = match.group("args")
            if "--cache-pairs" in args:
                continue
            out_match = OUT_RE.search(args)
            out = out_match.group(1) if out_match else "eval/out/smoke"
            if "--no-gate" in args:
                errors.append(f"pr-smoke: the {job_name} step writing {out} must not pass --no-gate; the absolute gates run in every tier")
            gates = GATES_FILE_RE.search(args)
            if gates is not None and gates.group(1) != QUALITY_GATES:
                errors.append(f"pr-smoke: the {job_name} step writing {out} must use {QUALITY_GATES}, not {gates.group(1)}")
            if re.search(r"--gates-mode\s+report\b", args) and out not in report_outs:
                errors.append(
                    f"pr-smoke: the {job_name} step writing {out} runs --gates-mode report, but {MEASUREMENT.relative_to(ROOT)} does not mark it report"
                )


def check_prompt_control(job: dict | None, errors: list[str]) -> None:
    if job is None:
        return
    runs = [str(step.get("run", "")) for step in all_steps(job)]
    regression = [run for run in runs if re.search(r'test\s+"?\$code"?\s+-eq\s+10\b', run)]
    if len(regression) < 2:
        errors.append("pr-smoke: gate-negative-control must keep both regression controls asserting 'test \"$code\" -eq 10'")
    control = [run for run in runs if PROMPT_CONTROL_OVERLAY in run]
    if not control or not any(re.search(r'test\s+"?\$code"?\s+-eq\s+11\b', run) for run in control):
        errors.append(
            f"pr-smoke: gate-negative-control must run the prompt control with --env-overlay {PROMPT_CONTROL_OVERLAY} and assert 'test \"$code\" -eq 11'"
        )
        return
    body = next(run for run in control if re.search(r'test\s+"?\$code"?\s+-eq\s+11\b', run))
    if not re.search(r"jq -e '[^']*false_answer_rate[^']*overall[^']*failed[^']*' \S+/gate\.json", body):
        errors.append("pr-smoke: the prompt control must assert a failed false_answer_rate check on overall with jq -e on its gate.json")


def check_manifest_verify(job: dict | None, errors: list[str]) -> None:
    lines = [line for line in step_text(job or {}).splitlines() if "rag_eval.golden_set verify" in line]
    for manifest in FIXTURE_MANIFESTS:
        if not any(f"--manifest {manifest}" in line for line in lines):
            errors.append(f"pr-smoke: job python must run 'python -m rag_eval.golden_set verify' for {manifest}")


def check_nightly_absolute(job: dict | None, errors: list[str]) -> None:
    if job is None:
        errors.append("nightly: job 'judge' missing")
        return
    flag = "HAS_JUDGE_KEYS == 'true'"
    steps = all_steps(job)
    runs = [str(step.get("run", "")) for step in steps]
    judge = next((i for i, run in enumerate(runs) if "rag_eval.judge.run" in run), None)
    stale = next((i for i, run in enumerate(runs) if "rag_eval.golden_set stale-scan" in run), None)
    if stale is None:
        errors.append("nightly: job judge must run the fixture 'rag_eval.golden_set stale-scan'")
    elif flag not in str(steps[stale].get("if", "")):
        errors.append(f"nightly: the stale-scan step must be conditioned on {flag}")
    gate = next((i for i, run in enumerate(runs) if "rag_eval.absolute_gate check" in run), None)
    if gate is None:
        errors.append("nightly: job judge must run 'python -m rag_eval.absolute_gate check --tier nightly' on its report")
        return
    body = runs[gate]
    if flag not in str(steps[gate].get("if", "")):
        errors.append(f"nightly: the absolute_gate step must be conditioned on {flag}")
    for needle in ("--tier nightly", "--report eval/out/nightly/report.json", f"--gates {QUALITY_GATES}", "--judge-report", f"--calibration {JUDGE_CALIBRATION}"):
        if needle not in body:
            errors.append(f"nightly: the absolute_gate step must pass {needle}")
    if not re.search(r"--mode\s+report\b", body):
        errors.append("nightly: the absolute_gate step must run with --mode report until the owner ratifies the floors (O-2)")
    if "secrets." in body:
        errors.append("nightly: the absolute_gate step must take secrets only through step env")
    if judge is None or gate < judge:
        errors.append("nightly: the absolute_gate step must run after the judge step")
    uploads = [step for step in steps if str(step.get("uses", "")).startswith("actions/upload-artifact@")]
    if not any("eval/out/nightly/absolute.json" in str((step.get("with") or {}).get("path", "")) for step in uploads):
        errors.append("nightly: job judge must upload eval/out/nightly/absolute.json")


def check_absolute_gates(pr: dict | None, nightly: dict | None, errors: list[str], measurement_path: Path = MEASUREMENT) -> None:
    """D-06, O-1, O-2: every CI tier carries the absolute gates; a tier runs report-only solely because the measurement says so."""
    try:
        report_outs = report_only_outs(measurement_path)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        errors.append(f"absolute gates: cannot read {measurement_path}: {exc}")
        return
    if pr is not None:
        jobs = pr.get("jobs") or {}
        for name in ("eval-smoke", "gate-negative-control"):
            if name in jobs:
                check_smoke_gate_flags(name, jobs[name], report_outs, errors)
        check_prompt_control(jobs.get("gate-negative-control"), errors)
        check_manifest_verify(jobs.get("python"), errors)
    if nightly is not None:
        check_nightly_absolute((nightly.get("jobs") or {}).get("judge"), errors)


def main() -> int:
    errors: list[str] = []
    if not PR.exists():
        errors.append(f"missing {PR.relative_to(ROOT)}")
    else:
        check_pr(errors)
    if NIGHTLY.exists():
        check_nightly(errors)
        check_no_ray_extra("nightly", NIGHTLY.read_text(encoding="utf-8"), errors)
    else:
        print("check-workflows: nightly.yml does not exist yet, skipping nightly assertions")
    if PR.exists():
        check_no_ray_extra("pr-smoke", PR.read_text(encoding="utf-8"), errors)
    if RAY_OPTIONAL.exists():
        check_ray_optional(*load(RAY_OPTIONAL), errors)
    else:
        errors.append(f"missing {RAY_OPTIONAL.relative_to(ROOT)}")
    if RELEASE_GATE.exists():
        known_refs = set()
        for path in (PR, NIGHTLY):
            if path.exists():
                known_refs.update(uses_refs(load(path)[0]))
        check_release_gate(*load(RELEASE_GATE), errors, known_refs)
        check_no_ray_extra("rag-release-gate", RELEASE_GATE.read_text(encoding="utf-8"), errors)
    else:
        errors.append(f"missing {RELEASE_GATE.relative_to(ROOT)}")
    if PROMOTE.exists():
        promote_refs = set()
        for path in (PR, NIGHTLY):
            if path.exists():
                promote_refs.update(uses_refs(load(path)[0]))
        check_promote_production(*load(PROMOTE), errors, promote_refs)
        check_no_ray_extra("promote-production", PROMOTE.read_text(encoding="utf-8"), errors)
    else:
        errors.append(f"missing {PROMOTE.relative_to(ROOT)}")
    if JUDGE_CALIBRATION_WORKFLOW.exists():
        data, text = load(JUDGE_CALIBRATION_WORKFLOW)
        check_common("judge-calibration", data, text, errors)
        check_judge_calibration(data, errors)
        check_no_ray_extra("judge-calibration", text, errors)
    else:
        errors.append(f"missing {JUDGE_CALIBRATION_WORKFLOW.relative_to(ROOT)}")
    check_lakera_secret_scope(errors)
    check_absolute_gates(load(PR)[0] if PR.exists() else None, load(NIGHTLY)[0] if NIGHTLY.exists() else None, errors)
    workflows = [load(path)[0] for path in (PR, NIGHTLY) if path.exists()]
    check_tsx_tests_covered(workflows, TESTS_DIR, errors)
    if errors:
        print("check-workflows: FAILED")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("check-workflows: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
