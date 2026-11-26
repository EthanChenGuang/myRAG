from rag_sidecar.contracts.feedback_loop import ShipCheckResult

EXIT_OK, EXIT_FAIL, EXIT_INPUT, EXIT_PRIVATE = 0, 1, 2, 6
DEFAULT_RESAMPLES = 0
DEFAULT_SEED = -1


def bootstrap_interval(differences, seed, resamples):
    return (-1.0, -1.0)


def run_ship_check(baseline, candidate, target, **kwargs):
    result = ShipCheckResult(
        passed=False,
        reasons=["not_implemented"],
        target_metric=target if target else "x",
        baseline_hash="0" * 64,
        candidate_hash="0" * 64,
        gate_population="all",
    )
    return result, []


def main(argv=None):
    return 99
