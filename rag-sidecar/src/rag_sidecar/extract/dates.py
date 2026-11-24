import re
from datetime import date

_CHINESE = re.compile(r"(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?")
_ISO = re.compile(r"(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)")
_DAY_FIRST = re.compile(r"(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?!\d)")


def _build(year: str, month: str, day: str) -> date | None:
    try:
        return date(int(year), int(month), int(day))
    except ValueError:
        return None


def find_date(text: str) -> date | None:
    """First valid date in the text, reading YYYY年M月D日, YYYY-MM-DD and DD/MM/YYYY."""
    found: list[tuple[int, date]] = []
    for pattern, day_first in ((_CHINESE, False), (_ISO, False), (_DAY_FIRST, True)):
        for match in pattern.finditer(text):
            first, second, third = match.groups()
            parsed = _build(third, second, first) if day_first else _build(first, second, third)
            if parsed is not None:
                found.append((match.start(), parsed))
    if not found:
        return None
    return min(found, key=lambda item: item[0])[1]


def parse_date(text: str) -> date | None:
    return find_date(text)
