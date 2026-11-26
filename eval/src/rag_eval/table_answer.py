"""Deterministic table_split answer check (D-46, EVAL-18): the gold cell value present, no distractor value given.

Numbers are compared as decimals, never as substrings: 42.5, 42.50 and 42,5 are equal, 425 is not. A number with one
separator reads it as the decimal point whichever of . and , it is; a number with both reads the last one as the decimal
point and the others as thousands groups. Full-width digits and the full-width full stop count as ASCII; the full-width
and ideographic commas separate list items. Text values match after NFKC case folding, as whole words in Latin script.
"""

import re
import unicodedata
from decimal import Decimal, InvalidOperation

from rag_sidecar.contracts.golden import TableAnswer
from rag_sidecar.contracts.report import TableAnswerVerdict

_DIGITS = {ord("０") + offset: ord("0") + offset for offset in range(10)}
_DIGITS[ord("．")] = ord(".")
_NUMBER = re.compile(r"(?<![0-9])[0-9]+(?:[.,][0-9]+)*")
_SEPARATOR = re.compile(r"[.,]")
_LATIN = "0-9a-zÀ-ɏ"
_WHITESPACE = re.compile(r"\s+")


def _ascii_digits(text: str) -> str:
    return text.translate(_DIGITS)


def _decimal(integer: str, fraction: str = "") -> Decimal:
    return Decimal(f"{integer}.{fraction}") if fraction else Decimal(integer)


def _grouped(groups: list[str]) -> bool:
    return all(len(group) == 3 for group in groups[1:])


def _parse_token(token: str) -> list[Decimal]:
    separators = _SEPARATOR.findall(token)
    groups = _SEPARATOR.split(token)
    if not separators:
        return [_decimal(token)]
    if len(separators) == 1:
        return [_decimal(groups[0], groups[1])]
    kinds = set(separators)
    if len(kinds) == 2 and separators[-1] not in separators[:-1] and _grouped(groups[:-1]):
        return [_decimal("".join(groups[:-1]), groups[-1])]
    if len(kinds) == 1 and _grouped(groups):
        return [_decimal("".join(groups))]
    # Not one well-formed number (for example "117.6,70.9"): a comma is read as a list separator, then each piece on its own.
    pieces = token.split(",") if len(kinds) == 2 else groups
    values: list[Decimal] = []
    for piece in pieces:
        values.extend(_parse_token(piece) if len(_SEPARATOR.findall(piece)) == 1 else [_decimal(group) for group in _SEPARATOR.split(piece)])
    return values


def extract_numbers(text: str) -> list[Decimal]:
    numbers: list[Decimal] = []
    for match in _NUMBER.finditer(_ascii_digits(text)):
        try:
            numbers.extend(_parse_token(match.group(0)))
        except InvalidOperation:
            continue
    return numbers


def _as_number(value: str) -> Decimal | None:
    stripped = _ascii_digits(value.strip())
    if not _NUMBER.fullmatch(stripped):
        return None
    parsed = extract_numbers(stripped)
    return parsed[0] if len(parsed) == 1 else None


def _fold(text: str) -> str:
    return _WHITESPACE.sub(" ", unicodedata.normalize("NFKC", text).casefold()).strip()


def _text_present(value: str, answer: str) -> bool:
    needle = _fold(value)
    if not needle:
        return False
    before = rf"(?<![{_LATIN}])" if re.match(rf"[{_LATIN}]", needle[0]) else ""
    after = rf"(?![{_LATIN}])" if re.match(rf"[{_LATIN}]", needle[-1]) else ""
    return re.search(before + re.escape(needle) + after, _fold(answer)) is not None


def _present(value: str, answer: str, numbers: list[Decimal]) -> bool:
    number = _as_number(value)
    if number is not None:
        return any(found == number for found in numbers)
    return _text_present(value, answer)


def score_table_answer(answer: str, table_answer: TableAnswer) -> TableAnswerVerdict:
    """correct: the gold value and no distractor; ambiguous: both; wrong: otherwise, including an empty answer."""
    if not answer or not answer.strip():
        return "wrong"
    numbers = extract_numbers(answer)
    gold = _present(table_answer.value, answer, numbers)
    distractor = any(_present(value, answer, numbers) for value in table_answer.distractor_values)
    if gold and distractor:
        return "ambiguous"
    return "correct" if gold else "wrong"
