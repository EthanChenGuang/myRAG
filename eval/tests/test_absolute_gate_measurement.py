"""The committed measurement record keeps the prechunked smoke tier gating false answers (plan 05.3-15, O-1, T-05.3-533).

The setting check of plan 05.3-22 treats a check that the record lists as failing for the prechunked smoke tier (the tier whose
--out is eval/out/smoke) as baseline_failing. So every false_answer_rate row of that tier, overall and per language, must be
recorded as passed, or a prompt that drops the refusal directive would pass the check unnoticed.
"""

import copy
import json

import pytest

from rag_eval.paths import REPO_ROOT

RECORD_PATH = REPO_ROOT / "eval/reports/phase-05.3/absolute-gate-measurement.json"
PRECHUNKED_SMOKE_OUT = "eval/out/smoke"
LANGUAGES = ("zh", "en", "it")
FALSE_ANSWER = "false_answer_rate"
NOT_MEASURED_REASONS = frozenset({"not_measured_no_keys"})


def _after(record: dict) -> list[dict]:
    return [entry for entry in record["tiers"] if entry["stage"] == "after"]


def prechunked_false_answer_problems(record: dict) -> list[str]:
    """Problems that would let the setting check hide a false-answer regression on the prechunked smoke tier."""
    tiers = [entry for entry in _after(record) if entry.get("out") == PRECHUNKED_SMOKE_OUT]
    if len(tiers) != 1:
        return [f"expected one stage after entry with out {PRECHUNKED_SMOKE_OUT}, found {len(tiers)}"]
    tier = tiers[0]
    problems: list[str] = []
    if tier.get("mode") not in ("enforce", "report"):
        problems.append(f"mode {tier.get('mode')!r}")
    rows = {row["slice"]: row for row in tier["checks"] if row["check"] == FALSE_ANSWER}
    for name in ("overall", *(f"language:{language}" for language in LANGUAGES)):
        row = rows.get(name)
        if row is None:
            problems.append(f"{FALSE_ANSWER} {name}: missing")
        elif row["result"] != "passed":
            problems.append(f"{FALSE_ANSWER} {name}: {row['result']}")
    return problems


FAILED_CODES = {"false_answer_rate": "false_answer_rate_exceeded", "false_refusal_rate": "false_refusal_rate_exceeded"}
# Gap 3 (quick-53): the prechunked tiers gate every check except false refusal, which stays report-only until owner H-10.
PRECHUNKED_REPORT_ONLY = {"eval/out/smoke": ["false_refusal_rate"], "eval/out/smoke-legacy": ["false_refusal_rate"], "eval/out/smoke-sec": ["false_refusal_rate"]}
INGEST_OUTS = ("eval/out/smoke-ingest", "eval/out/smoke-legacy-ingest")


def mode_problems(record: dict) -> list[str]:
    """Each stage after tier: enforce iff its would-be exit code is 0 once its report-only checks are set aside; a report tier
    names a failing check or a reason."""
    problems: list[str] = []
    for entry in _after(record):
        name, mode = entry["name"], entry.get("mode")
        listed = entry.get("report_only_checks")
        if listed is not None:
            allowed = {FAILED_CODES.get(check) for check in listed}
            others = [code for code in entry.get("failed") or [] if code not in allowed]
            if not listed or any(check not in FAILED_CODES for check in listed):
                problems.append(f"{name}: report_only_checks {listed!r} must name ceilings")
            elif mode == "enforce" and (others or entry.get("enforced_exit_code") != 0):
                problems.append(f"{name}: enforce with report-only {listed} but failing {others}")
            elif mode == "report" and not others:
                problems.append(f"{name}: report although only its report-only checks fail")
            elif mode not in ("enforce", "report"):
                problems.append(f"{name}: mode {mode!r}")
            continue
        if mode == "enforce":
            if entry.get("exit_code") != 0 or entry.get("failed"):
                problems.append(f"{name}: enforce with exit code {entry.get('exit_code')} and failed {entry.get('failed')}")
        elif mode == "report":
            if entry.get("reason") is not None:
                if entry["reason"] not in NOT_MEASURED_REASONS or entry.get("exit_code") is not None:
                    problems.append(f"{name}: report with reason {entry['reason']!r}")
            elif not entry.get("failed") or entry.get("exit_code") == 0:
                problems.append(f"{name}: report without a failing check")
        else:
            problems.append(f"{name}: mode {mode!r}")
    return problems


@pytest.fixture(scope="module")
def record():
    return json.loads(RECORD_PATH.read_text(encoding="utf-8"))


def test_the_prechunked_smoke_tier_records_every_false_answer_row_as_passed(record):
    assert prechunked_false_answer_problems(record) == []


def test_every_after_tier_has_a_mode_that_matches_its_measurement(record):
    after = _after(record)
    assert len(after) >= 5
    assert mode_problems(record) == []


def test_the_live_nightly_tier_is_report_only_until_keys_exist(record):
    live = [entry for entry in _after(record) if entry["name"] == "nightly-live"]
    assert len(live) == 1 and live[0]["mode"] == "report" and live[0]["reason"] == "not_measured_no_keys"


def _prechunked(copy_of: dict) -> dict:
    return next(entry for entry in _after(copy_of) if entry.get("out") == PRECHUNKED_SMOKE_OUT)


@pytest.mark.parametrize("slice_name", ["overall", "language:en"])
def test_a_failed_false_answer_row_is_caught(record, slice_name):
    mutated = copy.deepcopy(record)
    for row in _prechunked(mutated)["checks"]:
        if row["check"] == FALSE_ANSWER and row["slice"] == slice_name:
            row["result"] = "failed"
    assert prechunked_false_answer_problems(mutated) == [f"{FALSE_ANSWER} {slice_name}: failed"]


def test_an_insufficient_language_row_is_caught(record):
    mutated = copy.deepcopy(record)
    for row in _prechunked(mutated)["checks"]:
        if row["check"] == FALSE_ANSWER and row["slice"] == "language:zh":
            row["result"] = "insufficient_n"
    assert prechunked_false_answer_problems(mutated) == [f"{FALSE_ANSWER} language:zh: insufficient_n"]


def test_a_missing_prechunked_tier_or_mode_is_caught(record):
    without = copy.deepcopy(record)
    without["tiers"] = [entry for entry in without["tiers"] if not (entry["stage"] == "after" and entry.get("out") == PRECHUNKED_SMOKE_OUT)]
    assert prechunked_false_answer_problems(without)
    no_mode = copy.deepcopy(record)
    _prechunked(no_mode).pop("mode", None)
    assert prechunked_false_answer_problems(no_mode) == ["mode None"]
    assert mode_problems(no_mode)


def test_a_hand_set_mode_that_contradicts_the_measurement_is_caught(record):
    mutated = copy.deepcopy(record)
    tier = _prechunked(mutated)
    tier["mode"] = "report" if tier["mode"] == "enforce" else "enforce"
    assert mode_problems(mutated)


def test_the_prechunked_tiers_enforce_every_check_except_false_refusal(record):
    """Gap 3 (05.3-VERIFICATION): false_answer_rate gates the prechunked tiers now; false_refusal_rate waits for owner H-10."""
    after = {entry.get("out"): entry for entry in _after(record)}
    for out, listed in PRECHUNKED_REPORT_ONLY.items():
        entry = after.get(out)
        assert entry is not None, out
        assert entry.get("report_only_checks") == listed, out
        assert entry.get("mode") == "enforce" and entry.get("enforced_exit_code") == 0, out
    for out in INGEST_OUTS:
        entry = after[out]
        assert "report_only_checks" not in entry and entry["mode"] == "enforce", out


def test_a_report_only_tier_failing_another_check_is_caught(record):
    mutated = copy.deepcopy(record)
    tier = _prechunked(mutated)
    tier["report_only_checks"] = ["false_refusal_rate"]
    tier["mode"] = "enforce"
    tier["enforced_exit_code"] = 0
    tier["failed"] = ["false_refusal_rate_exceeded", "false_answer_rate_exceeded"]
    assert mode_problems(mutated)
