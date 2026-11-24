import json
import re
from dataclasses import dataclass
from pathlib import Path

from stdnum import luhn
from stdnum.cn import uscc
from stdnum.eu import vat
from stdnum.it import iva

from rag_sidecar.contracts.ingest import TaxIdScheme

_SEPARATORS = re.compile(r"[\s.\-/_]")
_IT_IVA_SHAPE = re.compile(r"\d{11}")
_CN_USCC_SHAPE = re.compile(r"[0-9A-Z]{18}")
_EU_VAT_SHAPE = re.compile(r"[A-Z]{2}[0-9A-Z]{2,12}")
VECTORS_PATH = Path(__file__).resolve().parents[4] / "tests" / "fixtures" / "ingest" / "tax-id-vectors.json"


@dataclass(frozen=True)
class TaxIdCheck:
    scheme: TaxIdScheme
    valid: bool
    normalized: str


def normalize_tax_id(raw: str) -> str:
    return _SEPARATORS.sub("", raw).upper()


def classify_tax_id(raw: str) -> TaxIdCheck:
    """Pick the scheme by shape and validate it with python-stdnum; no checksum is hand-rolled."""
    normalized = normalize_tax_id(raw)
    if _IT_IVA_SHAPE.fullmatch(normalized):
        return TaxIdCheck("it_iva", iva.is_valid(normalized), normalized)
    if _CN_USCC_SHAPE.fullmatch(normalized):
        return TaxIdCheck("cn_uscc", uscc.is_valid(normalized), normalized)
    if _EU_VAT_SHAPE.fullmatch(normalized):
        return TaxIdCheck("eu_vat", vat.is_valid(normalized), normalized)
    return TaxIdCheck("unknown", False, normalized)


def _with_italian_check_digit(body: str) -> str:
    return body + luhn.calc_check_digit(body)


def _with_changed_last_character(value: str) -> str:
    return value[:-1] + ("0" if value[-1] != "0" else "1")


def _candidates() -> list[tuple[TaxIdScheme, str]]:
    italian = [
        _with_italian_check_digit(body)
        for body in ("9999999999"[:7] + "999", "0000001001", "0000002100", "0000003120", "0000004121", "0000005888", "2345678001")
    ]
    italian_invalid = [
        _with_changed_last_character(italian[0]),
        _with_changed_last_character(italian[1]),
        _with_changed_last_character(italian[2]),
        _with_changed_last_character(italian[6]),
        _with_italian_check_digit("0000001101"),
        _with_italian_check_digit("0000000001"),
    ]
    chinese = [
        "91000000MA0000000N",
        "91000000MA0000001R",
        "91000000MA0000002W",
        "51000000MA1234567J",
        "9100000069ABCDEFG0",
        "110000001000000007",
    ]
    chinese_invalid = [
        "91000000MA0000000X",
        "91000000MA0000001T",
        "51000000MA1234567K",
        "91000000IA0000000N",
        "9100000069ABCDEFG1",
    ]
    european = ["IT99999999990", "DE100142542", "FR00000000093", "ATU10000005", "NL100000009B01", "BE0000000097"]
    european_invalid = ["IT99999999991", "DE100142543", "FR00000000094", "ATU10000006", "NL100000008B01", "XX12345678"]
    return [
        *(("it_iva", value) for value in [*italian, *italian_invalid, "999 999 999 90"]),
        *(("cn_uscc", value) for value in [*chinese, *chinese_invalid, "91000000-MA0000000-N"]),
        *(("eu_vat", value) for value in [*european, *european_invalid, "it 99999999990"]),
    ]


_DIRECT_VALIDATORS = {"it_iva": iva.is_valid, "cn_uscc": uscc.is_valid, "eu_vat": vat.is_valid}


def build_tax_id_vectors() -> dict[str, object]:
    vectors: list[dict[str, object]] = [
        {"scheme": scheme, "value": value, "valid": bool(_DIRECT_VALIDATORS[scheme](value))}
        for scheme, value in _candidates()
    ]
    vectors += [{"scheme": "unknown", "value": value, "valid": False} for value in ("12345", "9999999999", "99999999990999", "N/A")]
    return {
        "schema_version": 1,
        "note": "synthetic ids, validity computed with python-stdnum; regenerate with: uv run --directory rag-sidecar python -m rag_sidecar.extract.tax_ids",
        "normalization": (
            "remove whitespace and . - / _ then uppercase; 11 digits is it_iva, 18 letters or digits is cn_uscc, "
            "two letters plus 2 to 12 letters or digits is eu_vat, anything else is unknown and invalid"
        ),
        "vectors": vectors,
    }


def render_tax_id_vectors() -> str:
    return json.dumps(build_tax_id_vectors(), indent=2, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    VECTORS_PATH.write_text(render_tax_id_vectors(), encoding="utf-8")
