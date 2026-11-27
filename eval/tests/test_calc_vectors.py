import datetime as dt
from fractions import Fraction
from pathlib import Path

import pytest

from rag_eval.calc_vectors import (
    CalcVectorError,
    build_vectors,
    date_diff,
    display,
    dumps,
    main,
    parse_date,
    parse_decimal,
    round_string,
)

COMMITTED = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "calc" / "vectors.json"


def test_two_runs_write_identical_bytes(tmp_path: Path) -> None:
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    assert main(["--out", str(a)]) == 0
    assert main(["--out", str(b)]) == 0
    assert a.read_bytes() == b.read_bytes()


def test_committed_file_matches_generator() -> None:
    assert COMMITTED.read_text(encoding="utf-8") == dumps(build_vectors())


def test_every_case_has_an_id_and_an_expectation() -> None:
    cases = build_vectors()["cases"]
    assert len(cases) >= 500
    assert len({c["id"] for c in cases}) == len(cases)
    kinds = {c["kind"] for c in cases}
    assert kinds == {"parse", "binary", "list", "cap_each", "percentage", "round", "display", "date_diff"}
    for case in cases:
        assert "expected" in case


def test_point_one_plus_point_two_is_exact() -> None:
    assert parse_decimal("0.1") + parse_decimal("0.2") == Fraction(3, 10)


@pytest.mark.parametrize("text", ["1e3", "1,000", "NaN", "Infinity", "+1", ".5", "1.", "", "１", "1\n"])
def test_decimal_grammar_rejects(text: str) -> None:
    with pytest.raises(CalcVectorError) as err:
        parse_decimal(text)
    assert err.value.reason == "invalid_value"


@pytest.mark.parametrize(
    ("value", "places", "mode", "expected"),
    [
        (Fraction(5, 2), 0, "half_up", "3"),
        (Fraction(-5, 2), 0, "half_up", "-3"),
        (Fraction(5, 2), 0, "half_even", "2"),
        (Fraction(7, 2), 0, "half_even", "4"),
        (Fraction(21, 10), 0, "up", "3"),
        (Fraction(-21, 10), 0, "up", "-3"),
        (Fraction(29, 10), 0, "down", "2"),
        (Fraction(-29, 10), 0, "down", "-2"),
        (Fraction(-2, 5), 0, "half_even", "0"),
        (Fraction(1, 3), 4, "half_even", "0.3333"),
        (Fraction(2675, 1000), 2, "half_even", "2.68"),
        (Fraction(1, 2), 3, "down", "0.500"),
    ],
)
def test_hand_computed_rounding(value: Fraction, places: int, mode: str, expected: str) -> None:
    assert round_string(value, places, mode) == expected


def test_display() -> None:
    assert display(Fraction(3, 10)) == ("0.3", False)
    assert display(Fraction(1, 3)) == ("0.3333333333", True)
    assert display(Fraction(12)) == ("12", False)
    assert display(Fraction(5, 10**11)) == ("0", True)
    assert display(Fraction(15, 10**11)) == ("0.0000000002", True)


def test_hand_computed_dates() -> None:
    d = parse_date
    assert date_diff(d("2024-02-28"), d("2024-03-01"), "days", False) == 2
    assert date_diff(d("2023-02-28"), d("2023-03-01"), "days", False) == 1
    assert date_diff(d("2024-02-28"), d("2024-03-01"), "days", True) == 3
    assert date_diff(d("2023-05-15"), d("2023-05-15"), "days", True) == 1
    assert date_diff(d("2023-05-15"), d("2023-05-14"), "days", True) == -2
    assert date_diff(d("2024-01-31"), d("2024-02-29"), "months", False) == 0
    assert date_diff(d("2024-01-31"), d("2024-03-31"), "months", True) == 2
    assert date_diff(d("2024-02-29"), d("2025-02-28"), "years", False) == 0
    assert date_diff(d("1955-07-20"), d("2001-07-19"), "years", False) == 45
    assert date_diff(d("1969-12-31"), d("1970-01-01"), "days", False) == 1
    assert d("2000-02-29") == dt.date(2000, 2, 29)
    for bad in ("2024-02-30", "2023-13-01", "1900-02-29"):
        with pytest.raises(CalcVectorError):
            d(bad)
