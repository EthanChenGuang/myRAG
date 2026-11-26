"""Absolute quality gate (Phase 5.3 D-05 to D-09, D-30, D-49); stub until implemented."""

from rag_sidecar.contracts.quality_gates import AbsoluteGateResult, CompositionResult

EXIT_ABSOLUTE = 11
EXIT_COMPOSITION = 12


def evaluate(report, gates, *, tier, judge_report=None, calibration=None, running_fingerprints=None, today=None, mode="enforce"):
    return AbsoluteGateResult(
        passed=True, mode=mode, rag_mode=report.rag_mode, composition=CompositionResult(), stale_result="skipped", exit_code=0
    )


def exit_code_for(result) -> int:
    return 0


def main(argv=None) -> int:
    return 0
