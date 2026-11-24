import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

_PERCENT = re.compile(r"\d+(?:[.,]\d+)?\s*[%％]")
_TOKEN = re.compile(
    r"(?<![\w.,])-?\d{1,3}(?:[   .,']\d{3})+(?:[.,]\d+)?(?![\d])|(?<![\w.,])-?\d+(?:[.,]\d+)?(?![\d])"
)
_SPACES = re.compile(r"[   ']")
_CODES = {"EUR": "EUR", "USD": "USD", "CNY": "CNY", "RMB": "CNY", "GBP": "GBP", "CHF": "CHF", "JPY": "JPY"}
_CODE_PATTERN = re.compile(r"(?<![A-Za-z])(" + "|".join(_CODES) + r")(?![A-Za-z])")
_SYMBOLS = (("€", "EUR"), ("￥", "CNY"), ("¥", "CNY"), ("£", "GBP"), ("人民币", "CNY"), ("$", "USD"))
_YUAN = re.compile(r"\d\s*元")
_MAX_DECIMALS = 4


def _plain(token: str, locale_hint: str | None) -> str | None:
    negative = token.startswith("-")
    body = _SPACES.sub("", token.lstrip("-"))
    has_dot = "." in body
    has_comma = "," in body
    if has_dot and has_comma:
        decimal_sep = "." if body.rfind(".") > body.rfind(",") else ","
    elif has_dot or has_comma:
        sep = "." if has_dot else ","
        parts = body.split(sep)
        if len(parts) > 2:
            if any(len(part) != 3 for part in parts[1:]):
                return None
            decimal_sep = None
        elif len(parts[1]) != 3 or parts[0] == "0":
            decimal_sep = sep
        else:
            locale_decimal = "," if locale_hint == "it" else "."
            decimal_sep = sep if sep == locale_decimal else None
    else:
        decimal_sep = None
    thousands_sep = "," if decimal_sep == "." else "."
    if decimal_sep is None:
        integer, fraction = body.replace(".", "").replace(",", ""), ""
    else:
        integer_part, _, fraction = body.rpartition(decimal_sep)
        integer = integer_part.replace(thousands_sep, "")
    if not integer.isdigit() or (fraction and not fraction.isdigit()):
        return None
    if len(fraction) > _MAX_DECIMALS:
        try:
            quantum = Decimal(1).scaleb(-_MAX_DECIMALS)
            rounded = Decimal(f"{integer}.{fraction}").quantize(quantum, rounding=ROUND_HALF_UP)
        except InvalidOperation:
            return None
        integer, _, fraction = f"{rounded:f}".partition(".")
    integer = integer.lstrip("0") or "0"
    value = f"{integer}.{fraction}" if fraction else integer
    is_zero = not integer.strip("0") and not fraction.strip("0")
    return f"-{value}" if negative and not is_zero else value


def parse_amount(text: str, locale_hint: str | None = None) -> str | None:
    """Last number in the text as a plain decimal string; percentages are skipped so 'Tax 8 % 107.36' reads 107.36."""
    tokens = _TOKEN.findall(_PERCENT.sub(" ", text))
    if not tokens:
        return None
    return _plain(tokens[-1], locale_hint)


def detect_currency(text: str) -> str | None:
    code = _CODE_PATTERN.search(text)
    if code:
        return _CODES[code.group(1)]
    for symbol, currency in _SYMBOLS:
        if symbol in text:
            return currency
    if _YUAN.search(text):
        return "CNY"
    return None
