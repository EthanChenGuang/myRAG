EXIT_OK, EXIT_INPUT, EXIT_API, EXIT_PRIVATE = 0, 2, 4, 6


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


def build_drift_report(production, test_strata, offline_report, previous, bands, seed, **kwargs):
    from rag_sidecar.contracts.monitor import DriftReport

    return DriftReport(week=kwargs.get("week", "2026-W01"), state="ok", limits={"warn": 0, "alert": 0, "gap": 0})


def state_and_reason(divergence, null_p95, test_items, bands, min_sample=0):
    return ("alert", None)


def main(argv=None) -> int:
    return 1
