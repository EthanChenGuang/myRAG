"""Structural check of the Phase 1 GitHub Actions workflows.

Run locally with: python3 -I scripts/ci/check-workflows.py
Requires PyYAML. Exits 1 and lists every failed assertion.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
PR = ROOT / ".github" / "workflows" / "pr-smoke.yml"
NIGHTLY = ROOT / ".github" / "workflows" / "nightly.yml"
DOCKERFILE = ROOT / "rag-sidecar" / "Dockerfile"

TESTS_DIR = ROOT / "tests"
TSX_GLOB = "tests/*.test.mts"
TSX_COMMAND_RE = re.compile(r"node\s+--import\s+tsx\s+--test\b(?P<args>[^\n]*)")

PR_JOBS = ["ts", "sibling-types", "voice-agent", "schema-parity", "python", "eval-smoke", "gate-negative-control", "docker-build"]
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
USES_LINE_RE = re.compile(r"^\s*(?:-\s+)?uses:\s*(?P<ref>\S+)(?P<rest>.*)$")
VERSION_COMMENT_RE = re.compile(r"^\s+#\s*v\d+(\.\d+){0,2}\s*$")
UV_IMAGE_RE = re.compile(r"ghcr\.io/astral-sh/uv:(?P<version>\d+\.\d+\.\d+)")
SKIP_NOTICE = "::notice::judge key not configured, skipping"
ONLINE_SKIP_NOTICE = "::notice::langfuse keys not configured, skipping online judge"
DOCLING_SKIP_NOTICE = "::notice::docling extra not installable, skipping"
DOCLING_READY = "steps.docling.outputs.ready == 'true'"
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
    # every job that runs eval pytest or the harness must sync eval with all extras
    for jname, job in jobs.items():
        body = step_text(job)
        needs_eval = "eval" in body and ("pytest" in body or "test-rag" in body or "vitest" in body)
        if needs_eval and "uv sync --directory eval --locked --all-extras" not in body:
            errors.append(f"pr-smoke: job '{jname}' uses eval but does not sync it with --locked --all-extras")
    ts = jobs.get("ts")
    if ts is not None:
        body = step_text(ts)
        for needle in (
            "npx vitest run",
            "node --import tsx --test",
            "tests/rag-db/",
            "tests/rag-e2e/*.test.mts",
            "nullglob",
            "node scripts/check-config.mjs",
            "scripts/check-config.test.mjs",
            "scripts/tests/gen-zod.node-test.mjs",
            "npm run typecheck:new",
            "next typegen",
            "npx tsc --noEmit -p tsconfig.json",
            "scripts/tests/tsc-ratchet.node-test.mjs",
            "scripts/ci/check-node-runtime.mjs",
            "scripts/tests/check-node-runtime.node-test.mjs",
            "scripts/ci/check-workflows.py",
            "scripts/ci/check-rag-boundary.mjs",
            "scripts/tests/check-rag-boundary.node-test.mjs",
        ):
            if needle not in body:
                errors.append(f"pr-smoke: job ts is missing '{needle}'")
        if "scripts/ci/tsc-baseline.json" in body or re.search(r"tsc-ratchet\.mjs(?![^\n]*--cwd)", body):
            errors.append("pr-smoke: job ts must run plain tsc, not the root tsc ratchet or its baseline")
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
    py_job = jobs.get("python")
    if py_job is not None:
        body = step_text(py_job)
        for needle in (
            "uv sync --directory rag-sidecar --locked --extra chunking",
            "uv sync --directory rag-sidecar --locked --extra preflight",
            "uv run --directory rag-sidecar --extra chunking pytest -q",
        ):
            if needle not in body:
                errors.append(f"pr-smoke: job python is missing '{needle}'")
        if "--extra docling" in body:
            errors.append("pr-smoke: job python must not install the heavy docling extra")
        if "--extra ray" in body:
            errors.append("pr-smoke: job python must not install the ray extra")
    sp = jobs.get("schema-parity")
    if sp is not None:
        body = step_text(sp)
        if "npm run gen:schemas" not in body or "git diff --exit-code" not in body:
            errors.append("pr-smoke: schema-parity must regenerate then git diff --exit-code")
    for jname in ("ts", "schema-parity", "eval-smoke", "gate-negative-control"):
        job = jobs.get(jname)
        if job is not None and "npm ci" not in step_text(job):
            errors.append(f"pr-smoke: job {jname} must install with npm ci")
    docker = jobs.get("docker-build")
    if docker is not None:
        body = step_text(docker)
        for needle in ("docker build -t rag-sidecar:ci rag-sidecar", "/health", "/ready", "/v1/info", "RAG_SIDECAR_SECRET"):
            if needle not in body:
                errors.append(f"pr-smoke: job docker-build is missing '{needle}'")


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
    for step in steps:
        run = str(step.get("run", ""))
        if "secrets." in run:
            errors.append("nightly: online-judge secrets must be passed through step env, not interpolated into run")
        if re.search(r"\becho\b.*\bKEY\b", run):
            errors.append("nightly: an online-judge step appears to echo a key")


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


def check_nightly(errors: list[str]) -> None:
    data, text = load(NIGHTLY)
    check_common("nightly", data, text, errors)
    trig = triggers(data)
    for t in ("schedule", "workflow_dispatch"):
        if t not in trig:
            errors.append(f"nightly: trigger '{t}' missing")
    for forbidden in ("pull_request", "push"):
        if forbidden in trig:
            errors.append(f"nightly: trigger '{forbidden}' must not be used (secrets must never reach fork code)")
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


def main() -> int:
    errors: list[str] = []
    if not PR.exists():
        errors.append(f"missing {PR.relative_to(ROOT)}")
    else:
        check_pr(errors)
    if NIGHTLY.exists():
        check_nightly(errors)
    else:
        print("check-workflows: nightly.yml does not exist yet, skipping nightly assertions")
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
