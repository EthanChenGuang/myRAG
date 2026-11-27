"""Tenant nightly drain (Phase 5.3 D-19). Stub."""

from rag_eval.nightly_run import run_nightly_tier

_run_nightly = run_nightly_tier


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


def main(argv: list[str] | None = None) -> int:
    return 99
