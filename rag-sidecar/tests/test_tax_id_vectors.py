import json
from datetime import date
from pathlib import Path

import pytest

from rag_sidecar.extract.amounts import detect_currency, parse_amount
from rag_sidecar.extract.dates import find_date, parse_date
from rag_sidecar.extract.tax_ids import classify_tax_id, render_tax_id_vectors

VECTORS_PATH = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "ingest" / "tax-id-vectors.json"
VECTORS = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))["vectors"]


def test_parse_date_reads_the_chinese_form():
    assert parse_date("2025年3月15日") == date(2025, 3, 15)
    assert parse_date("2025年03月05日") == date(2025, 3, 5)


def test_parse_date_reads_day_first_slash_form():
    assert parse_date("15/03/2025") == date(2025, 3, 15)
    assert parse_date("5/3/2025") == date(2025, 3, 5)


def test_parse_date_reads_iso_form():
    assert parse_date("2025-03-15") == date(2025, 3, 15)


def test_parse_date_rejects_impossible_calendar_dates():
    assert parse_date("31/02/2025") is None
    assert parse_date("2025-13-01") is None
    assert parse_date("no date here") is None


def test_find_date_picks_the_first_date_inside_a_longer_value():
    assert find_date("Data 15/03/2025 scadenza 14/04/2025") == date(2025, 3, 15)
    assert find_date("开票日期 2025年3月15日 (含税)") == date(2025, 3, 15)


def test_parse_amount_handles_both_separator_conventions():
    assert parse_amount("1.234,56", locale_hint="it") == "1234.56"
    assert parse_amount("1,234.56") == "1234.56"
    assert parse_amount("1.234,56") == "1234.56"


def test_parse_amount_uses_the_locale_for_a_lone_separator():
    assert parse_amount("99,00") == "99.00"
    assert parse_amount("1.234", locale_hint="it") == "1234"
    assert parse_amount("1,234", locale_hint="it") == "1.234"
    assert parse_amount("1,234", locale_hint="en") == "1234"
    assert parse_amount("1 234,50") == "1234.50"


def test_parse_amount_skips_percentages_and_signs_negatives():
    assert parse_amount("Tax 8 % 107.36") == "107.36"
    assert parse_amount("-12,50", locale_hint="it") == "-12.50"
    assert parse_amount("n/a") is None


def test_currency_is_detected_separately_from_the_amount():
    assert parse_amount("€ 99,00") == "99.00"
    assert detect_currency("€ 99,00") == "EUR"
    assert parse_amount("¥1,200.00") == "1200.00"
    assert detect_currency("¥1,200.00") == "CNY"
    assert detect_currency("Total USD 10.00") == "USD"
    assert detect_currency("Total 10.00") is None


def test_classify_tax_id_accepts_the_synthetic_ids_of_each_scheme():
    italian = classify_tax_id("99999999990")
    assert (italian.scheme, italian.valid) == ("it_iva", True)
    chinese = classify_tax_id("91000000MA0000000N")
    assert (chinese.scheme, chinese.valid) == ("cn_uscc", True)
    european = classify_tax_id("IT99999999990")
    assert (european.scheme, european.valid) == ("eu_vat", True)


def test_classify_tax_id_rejects_a_failed_checksum():
    broken = classify_tax_id("99999999991")
    assert (broken.scheme, broken.valid) == ("it_iva", False)
    assert classify_tax_id("91000000MA0000000X").valid is False
    assert classify_tax_id("IT99999999991").valid is False


def test_classify_tax_id_normalizes_separators_and_case():
    spaced = classify_tax_id("it 999 999 999 90")
    assert (spaced.scheme, spaced.valid, spaced.normalized) == ("eu_vat", True, "IT99999999990")


@pytest.mark.parametrize("vector", VECTORS, ids=[f"{v['scheme']}:{v['value']}" for v in VECTORS])
def test_every_committed_vector_matches_the_classifier(vector):
    result = classify_tax_id(vector["value"])
    assert (result.scheme, result.valid) == (vector["scheme"], vector["valid"])


def test_each_scheme_has_four_valid_and_four_invalid_vectors():
    for scheme in ("it_iva", "cn_uscc", "eu_vat"):
        valid = [v for v in VECTORS if v["scheme"] == scheme and v["valid"]]
        invalid = [v for v in VECTORS if v["scheme"] == scheme and not v["valid"]]
        assert len(valid) >= 4, scheme
        assert len(invalid) >= 4, scheme


def test_committed_vector_file_equals_the_regenerated_content():
    assert render_tax_id_vectors() == VECTORS_PATH.read_text(encoding="utf-8")
