"""Test vectors for the exact calculation module (plan 05.2.1-03, D-67, D-68, D-95).

A second implementation of the closed operation set, written on the standard
library only: ``fractions.Fraction`` for exact values, ``decimal`` for rounding
and ``datetime.date.toordinal`` for day differences. The TypeScript module in
``src/lib/rag/calc/`` replays the committed output.

Rounding modes (D-95): ``half_up`` ties away from zero, ``half_even`` ties to
the even digit, ``up`` away from zero, ``down`` toward zero.

Display (D-68): at most 10 fractional digits, half-even, trailing zeros
removed; ``display_rounded`` is true when the exact value has more than 10
fractional digits. A zero result is never written with a minus sign.

Months and years in ``date_diff`` are complete units: the month count is the
calendar month difference, minus one when the later date's day of month is
below the earlier date's; years are complete months divided by twelve. The
sign follows ``b - a``. ``inclusive`` adds one day (in the direction of the
difference, or plus one for equal dates) for the ``days`` unit only.

Usage: ``python -m rag_eval.calc_vectors --out PATH``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import re
import sys
from decimal import (
    ROUND_DOWN,
    ROUND_HALF_EVEN,
    ROUND_HALF_UP,
    ROUND_UP,
    Context,
    Decimal,
    Inexact,
)
from fractions import Fraction
from pathlib import Path
from typing import Any

SEED = 52103
VERSION = 1
DISPLAY_PLACES = 10

DECIMAL_RE = re.compile(r"-?[0-9]+(\.[0-9]+)?", re.ASCII)
DATE_RE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})", re.ASCII)

MODES = {
    "half_up": ROUND_HALF_UP,
    "half_even": ROUND_HALF_EVEN,
    "up": ROUND_UP,
    "down": ROUND_DOWN,
}


class CalcVectorError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def parse_decimal(text: str) -> Fraction:
    if not isinstance(text, str) or DECIMAL_RE.fullmatch(text) is None:
        raise CalcVectorError("invalid_value")
    return Fraction(Decimal(text))


def parse_date(text: str) -> dt.date:
    m = DATE_RE.fullmatch(text) if isinstance(text, str) else None
    if m is None:
        raise CalcVectorError("invalid_date")
    try:
        return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError as exc:
        raise CalcVectorError("invalid_date") from exc


def exact(value: Fraction) -> dict[str, str]:
    return {"n": str(value.numerator), "d": str(value.denominator)}


def _decimal_of(value: Fraction) -> Decimal:
    """The exact value when it terminates, else a truncation with a sticky digit.

    The sticky digit sits far beyond any place we round at, so every rounding
    mode decides as it would on the exact value, and a non-terminating value is
    never mistaken for a tie.
    """
    ctx = Context(prec=4000, rounding=ROUND_DOWN, traps=[])
    q = ctx.divide(Decimal(value.numerator), Decimal(value.denominator))
    if not ctx.flags[Inexact]:
        return q
    sticky = Decimal(1).scaleb(q.adjusted() - 4005)
    wide = Context(prec=9000, traps=[])
    return wide.add(q, sticky) if value > 0 else wide.subtract(q, sticky)


def _render(q: Decimal) -> str:
    text = format(q, "f")
    if text.startswith("-") and q.is_zero():
        text = text[1:]
    return text


def round_string(value: Fraction, places: int, mode: str) -> str:
    q = _decimal_of(value).quantize(Decimal(1).scaleb(-places), rounding=MODES[mode], context=Context(prec=9000))
    return _render(q)


def display(value: Fraction) -> tuple[str, bool]:
    text = round_string(value, DISPLAY_PLACES, "half_even")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text == "-0":
        text = "0"
    terminates_within = (value * 10**DISPLAY_PLACES).denominator == 1
    return text, not terminates_within


def complete_months(a: dt.date, b: dt.date) -> int:
    lo, hi, sign = (a, b, 1) if a <= b else (b, a, -1)
    months = (hi.year - lo.year) * 12 + (hi.month - lo.month)
    if hi.day < lo.day:
        months -= 1
    return sign * months


def date_diff(a: dt.date, b: dt.date, unit: str, inclusive: bool) -> int:
    if unit == "days":
        days = b.toordinal() - a.toordinal()
        if inclusive:
            days = days - 1 if days < 0 else days + 1
        return days
    months = complete_months(a, b)
    if unit == "months":
        return months
    years = abs(months) // 12
    return years if months >= 0 else -years


# ---------------------------------------------------------------- generators


def rand_decimal(rng: random.Random, *, int_digits: int = 9, frac_digits: int = 8, allow_neg: bool = True) -> str:
    ip = str(rng.randint(0, 10 ** rng.randint(1, int_digits) - 1))
    fd = rng.randint(0, frac_digits)
    text = ip if fd == 0 else f"{ip}.{rng.randint(0, 10**fd - 1):0{fd}d}"
    if allow_neg and rng.random() < 0.35:
        text = "-" + text
    return text


def rand_tie(rng: random.Random, places: int) -> str:
    ip = str(rng.randint(0, 999))
    digits = "".join(str(rng.randint(0, 9)) for _ in range(places)) + "5"
    text = f"{ip}.{digits}"
    return "-" + text if rng.random() < 0.5 else text


def rand_date(rng: random.Random) -> dt.date:
    start = dt.date(1890, 1, 1).toordinal()
    end = dt.date(2090, 12, 31).toordinal()
    return dt.date.fromordinal(rng.randint(start, end))


def _ok(value: Fraction) -> dict[str, Any]:
    text, rounded = display(value)
    return {"exact": exact(value), "display": text, "display_rounded": rounded}


def _err(reason: str) -> dict[str, Any]:
    return {"error": reason}


def binary_cases(rng: random.Random) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    fixed = [("0.1", "0.2"), ("1", "3"), ("-2.5", "0.5"), ("0", "-0"), ("10", "0"), ("0.000001", "1000000")]
    pairs = fixed + [(rand_decimal(rng), rand_decimal(rng)) for _ in range(30)]
    for op in ("add", "subtract", "multiply", "divide"):
        for a, b in pairs:
            fa, fb = parse_decimal(a), parse_decimal(b)
            if op == "add":
                expected = _ok(fa + fb)
            elif op == "subtract":
                expected = _ok(fa - fb)
            elif op == "multiply":
                expected = _ok(fa * fb)
            else:
                expected = _err("division_by_zero") if fb == 0 else _ok(fa / fb)
            cases.append({"kind": "binary", "op": op, "args": [a, b], "expected": expected})
    return cases


def list_cases(rng: random.Random) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    lists = [["7"], ["-1.5"], ["0.1", "0.2", "0.3"], ["5", "-5", "5.0"]]
    lists += [[rand_decimal(rng) for _ in range(rng.randint(1, 12))] for _ in range(14)]
    for op in ("min", "max", "sum"):
        cases.append({"kind": "list", "op": op, "args": [], "expected": _err("invalid_request")})
        for values in lists:
            fs = [parse_decimal(v) for v in values]
            value = min(fs) if op == "min" else max(fs) if op == "max" else sum(fs, Fraction(0))
            cases.append({"kind": "list", "op": op, "args": values, "expected": _ok(value)})
    return cases


def cap_each_cases(rng: random.Random) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    fixed = [(["120", "80", "100"], "100"), (["0.5"], "0.25"), (["-3", "3"], "0")]
    for values, cap in fixed + [
        ([rand_decimal(rng, allow_neg=False) for _ in range(rng.randint(1, 10))], rand_decimal(rng, allow_neg=False))
        for _ in range(17)
    ]:
        fc = parse_decimal(cap)
        out = [_ok(min(parse_decimal(v), fc)) for v in values]
        cases.append({"kind": "cap_each", "op": "cap_each", "args": values, "cap": cap, "expected": {"list": out}})
    cases.append({"kind": "cap_each", "op": "cap_each", "args": [], "cap": "1", "expected": _err("invalid_request")})
    return cases


def percentage_cases(rng: random.Random) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    fixed = [("200", "15"), ("0.1", "33.3"), ("-80", "12.5"), ("1", "0")]
    for v, p in fixed + [(rand_decimal(rng), rand_decimal(rng, int_digits=3, frac_digits=4)) for _ in range(26)]:
        value = parse_decimal(v) * parse_decimal(p) / 100
        cases.append({"kind": "percentage", "op": "percentage", "args": [v, p], "expected": _ok(value)})
    return cases


def round_cases(rng: random.Random) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    values: list[tuple[Fraction, int]] = []
    fixed = ["2.5", "-2.5", "3.5", "-3.5", "0.5", "-0.5", "0.4", "-0.4", "1.005", "2.675", "-0.0000001", "0"]
    for text in fixed:
        values += [(parse_decimal(text), 0), (parse_decimal(text), 2)]
    values += [(Fraction(1, 3), 5), (Fraction(-2, 3), 0), (Fraction(2, 3), 20), (Fraction(1, 7), 10)]
    for _ in range(14):
        places = rng.randint(0, 6)
        values.append((parse_decimal(rand_tie(rng, places)), places))
    for _ in range(12):
        values.append((Fraction(rng.randint(-(10**9), 10**9), rng.randint(1, 10**5)), rng.randint(0, 20)))
    for value, places in values:
        for mode in MODES:
            cases.append(
                {
                    "kind": "round",
                    "op": "round",
                    "value": exact(value),
                    "places": places,
                    "mode": mode,
                    "expected": {"string": round_string(value, places, mode)},
                }
            )
    return cases


def display_cases(rng: random.Random) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    fixed = [
        Fraction(3, 10),
        Fraction(1, 3),
        Fraction(-1, 3),
        Fraction(0),
        Fraction(12),
        Fraction(1, 10**10),
        Fraction(1, 10**11),
        Fraction(5, 10**11),
        Fraction(15, 10**11),
        Fraction(-5, 10**11),
        Fraction(99999999999, 10**11),
        Fraction(1, 1024),
    ]
    fixed += [Fraction(rng.randint(-(10**12), 10**12), rng.randint(1, 10**6)) for _ in range(18)]
    for value in fixed:
        text, rounded = display(value)
        cases.append(
            {"kind": "display", "op": "display", "value": exact(value), "expected": {"display": text, "display_rounded": rounded}}
        )
    return cases


def parse_cases() -> list[dict[str, Any]]:
    texts = [
        "0", "-0", "007", "0.1", "-12.340", "123456789012345678901234567890.000000000000000000001",
        "1e3", "1,000", "NaN", "Infinity", "-Infinity", "+1", ".5", "1.", "", " 1", "1 ", "--1", "1.2.3",
        "１", "١", "0x10", "1_000", "1\n",
    ]
    cases: list[dict[str, Any]] = []
    for text in texts:
        try:
            expected: dict[str, Any] = {"exact": exact(parse_decimal(text))}
        except CalcVectorError as exc:
            expected = _err(exc.reason)
        cases.append({"kind": "parse", "op": "parse", "args": [text], "expected": expected})
    return cases


def date_cases(rng: random.Random) -> list[dict[str, Any]]:
    pairs = [
        ("2024-02-28", "2024-03-01"),
        ("2023-02-28", "2023-03-01"),
        ("2024-02-29", "2025-02-28"),
        ("2024-02-29", "2028-02-29"),
        ("2024-01-31", "2024-02-29"),
        ("2024-01-31", "2024-03-31"),
        ("2024-03-31", "2024-04-30"),
        ("2023-05-15", "2023-05-15"),
        ("2023-05-15", "2023-05-14"),
        ("1969-12-31", "1970-01-01"),
        ("1900-02-28", "1900-03-01"),
        ("2000-02-28", "2000-03-01"),
        ("1955-07-20", "2001-07-19"),
        ("2030-06-10", "1999-06-11"),
    ]
    pairs += [(rand_date(rng).isoformat(), rand_date(rng).isoformat()) for _ in range(16)]
    cases: list[dict[str, Any]] = []
    for a, b in pairs:
        da, db = parse_date(a), parse_date(b)
        for unit in ("days", "months", "years"):
            for inclusive in (False, True):
                value = Fraction(date_diff(da, db, unit, inclusive))
                cases.append(
                    {
                        "kind": "date_diff",
                        "op": "date_diff",
                        "args": [a, b],
                        "unit": unit,
                        "inclusive": inclusive,
                        "expected": _ok(value),
                    }
                )
    invalid = ["2024-02-30", "2023-13-01", "2023-02-29", "1900-02-29", "0000-01-01", "2024-1-01", "2024-01-01T00:00", "20240101", ""]
    for text in invalid:
        try:
            parse_date(text)
            expected: dict[str, Any] = {"ok": True}
        except CalcVectorError as exc:
            expected = _err(exc.reason)
        cases.append(
            {"kind": "date_diff", "op": "date_diff", "args": [text, "2024-01-01"], "unit": "days", "inclusive": False, "expected": expected}
        )
    return cases


def build_vectors(seed: int = SEED) -> dict[str, Any]:
    rng = random.Random(seed)
    cases = (
        parse_cases()
        + binary_cases(rng)
        + list_cases(rng)
        + cap_each_cases(rng)
        + percentage_cases(rng)
        + round_cases(rng)
        + display_cases(rng)
        + date_cases(rng)
    )
    for i, case in enumerate(cases):
        case["id"] = f"{case['kind']}-{i:04d}"
    return {
        "version": VERSION,
        "seed": seed,
        "generator": "eval/src/rag_eval/calc_vectors.py",
        "display_places": DISPLAY_PLACES,
        "cases": cases,
    }


def dumps(vectors: dict[str, Any]) -> str:
    return json.dumps(vectors, indent=1, sort_keys=True, ensure_ascii=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.calc_vectors", description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, help="output JSON path")
    args = parser.parse_args(argv)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(dumps(build_vectors()), encoding="utf-8", newline="\n")
    print(f"[Calc Vectors] wrote {len(build_vectors()['cases'])} cases to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
