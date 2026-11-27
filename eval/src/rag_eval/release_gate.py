"""Release gate (Phase 5.3 D-33 to D-36). Stub."""

from pathlib import Path

from rag_eval.nightly_run import run_nightly_tier
from rag_eval.paths import REPO_ROOT

GATE_FILES: dict = {}
RELEASE_GATE_CONFIG = REPO_ROOT / "eval" / "config" / "release-gate.json"
GATE_POPULATION = REPO_ROOT / "eval" / "config" / "gate-population.json"
PRIVATE_DOMAIN_DIR = REPO_ROOT / "eval" / "golden" / "private" / "domain"
_run_nightly = run_nightly_tier


def _git_head() -> str:
    return ""


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


def status_for(result) -> tuple[str, str]:
    return ("", "")


def main(argv: list[str] | None = None) -> int:
    return 99
