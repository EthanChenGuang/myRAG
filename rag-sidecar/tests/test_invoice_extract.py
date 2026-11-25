import json
import time
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from rag_sidecar.contracts import InvoiceFields, SidecarError
from rag_sidecar.extract import invoice as invoice_module
from rag_sidecar.extract.invoice import extract_invoice
from rag_sidecar.main import create_app
from rag_sidecar.settings import SidecarSettings

SECRET = "k" * 48
HEADER = "x-sidecar-secret"
ROUTE = "/v1/extract/invoice"

ZH_INVOICE = """# 增值税电子普通发票

发票号码：FP-2025-00417
开票日期：2025年3月15日

购买方
名称：示例买方有限公司
纳税人识别号：91000000MA0000001R

销售方
名称：示例销售有限公司
纳税人识别号：91000000MA0000000N

| 项目名称 | 数量 | 单价 | 金额 | 税率 | 税额 |
| --- | --- | --- | --- | --- | --- |
| 测试传感器 | 2 | 300.00 | 600.00 | 13% | 78.00 |
| 安装服务 | 1 | 400.00 | 400.00 | 13% | 52.00 |
| 合计 |  |  | ¥1,000.00 |  | ¥130.00 |

价税合计（小写）：¥1,130.00
"""

EN_INVOICE = """# Invoice

Invoice No.: INV-2025-00418
Invoice date: 2025-03-15
Due date: 2025-04-14

Supplier: Example Supplier Ltd
VAT No.: DE100142542

Bill to: Example Buyer GmbH
VAT No.: FR00000000093

| Description | Qty | Unit price | Amount | VAT % |
| --- | --- | --- | --- | --- |
| Thermal probe | 8 | 100.00 | 800.00 | 20% |
| Probe cable 5 m | 4 | 50.00 | 200.00 | 20% |

Subtotal: EUR 1,000.00
VAT 20 %: EUR 200.00
Total: EUR 1,200.00
"""

IT_INVOICE = """## Fattura

Numero fattura: FT-2025-00419
Data: 15/03/2025
Data scadenza: 14/04/2025

Cedente/Prestatore: Esempio Fornitore S.r.l.
P.IVA: 99999999990

Cessionario/Committente: Esempio Cliente S.p.A.
P.IVA: 00000010017

| Descrizione | Quantità | Prezzo unitario | Importo | Aliquota IVA |
| --- | --- | --- | --- | --- |
| Sonda termica | 8 | 100,00 | 800,00 | 22% |
| Cavo di ricambio 5 m | 4 | 50,00 | 200,00 | 22% |

Imponibile: € 1.000,00
IVA 22 %: € 220,00
Totale documento: € 1.220,00
"""


def test_chinese_invoice_yields_every_field():
    fields = extract_invoice(ZH_INVOICE)
    assert fields.invoice_number == "FP-2025-00417"
    assert fields.issue_date == date(2025, 3, 15)
    assert fields.supplier.name == "示例销售有限公司"
    assert (fields.supplier.tax_id, fields.supplier.tax_id_scheme) == ("91000000MA0000000N", "cn_uscc")
    assert fields.buyer.name == "示例买方有限公司"
    assert (fields.buyer.tax_id, fields.buyer.tax_id_scheme) == ("91000000MA0000001R", "cn_uscc")
    assert fields.currency == "CNY"
    assert (fields.net_total, fields.tax_total, fields.gross_total) == ("1000.00", "130.00", "1130.00")
    assert [(i.description, i.quantity, i.unit_price, i.amount, i.tax_rate) for i in fields.line_items] == [
        ("测试传感器", "2", "300.00", "600.00", "13"),
        ("安装服务", "1", "400.00", "400.00", "13"),
    ]
    assert fields.errors == []
    assert fields.confidence == 1.0


def test_italian_invoice_yields_the_same_field_set():
    fields = extract_invoice(IT_INVOICE)
    assert fields.invoice_number == "FT-2025-00419"
    assert fields.issue_date == date(2025, 3, 15)
    assert fields.due_date == date(2025, 4, 14)
    assert fields.supplier.name == "Esempio Fornitore S.r.l."
    assert (fields.supplier.tax_id, fields.supplier.tax_id_scheme) == ("99999999990", "it_iva")
    assert fields.buyer.name == "Esempio Cliente S.p.A."
    assert (fields.buyer.tax_id, fields.buyer.tax_id_scheme) == ("00000010017", "it_iva")
    assert fields.currency == "EUR"
    assert (fields.net_total, fields.tax_total, fields.gross_total) == ("1000.00", "220.00", "1220.00")
    assert [(i.description, i.quantity, i.unit_price, i.amount, i.tax_rate) for i in fields.line_items] == [
        ("Sonda termica", "8", "100.00", "800.00", "22"),
        ("Cavo di ricambio 5 m", "4", "50.00", "200.00", "22"),
    ]
    assert fields.errors == []
    assert fields.confidence == 1.0


def test_english_invoice_yields_the_same_field_set():
    fields = extract_invoice(EN_INVOICE)
    assert fields.invoice_number == "INV-2025-00418"
    assert fields.issue_date == date(2025, 3, 15)
    assert fields.due_date == date(2025, 4, 14)
    assert fields.supplier.name == "Example Supplier Ltd"
    assert (fields.supplier.tax_id, fields.supplier.tax_id_scheme) == ("DE100142542", "eu_vat")
    assert fields.buyer.name == "Example Buyer GmbH"
    assert (fields.buyer.tax_id, fields.buyer.tax_id_scheme) == ("FR00000000093", "eu_vat")
    assert fields.currency == "EUR"
    assert (fields.net_total, fields.tax_total, fields.gross_total) == ("1000.00", "200.00", "1200.00")
    assert [(i.description, i.quantity, i.unit_price, i.amount, i.tax_rate) for i in fields.line_items] == [
        ("Thermal probe", "8", "100.00", "800.00", "20"),
        ("Probe cable 5 m", "4", "50.00", "200.00", "20"),
    ]
    assert fields.errors == []
    assert fields.confidence == 1.0


def test_line_items_come_from_the_tables_argument_when_the_markdown_has_none():
    table = "| Description | Qty | Unit price | Amount |\n| --- | --- | --- | --- |\n| Thermal probe | 8 | 100.00 | 800.00 |\n"
    markdown = EN_INVOICE.split("| Description")[0] + "Total: EUR 1,200.00\n"
    fields = extract_invoice(markdown, tables=[table])
    assert [(i.description, i.amount) for i in fields.line_items] == [("Thermal probe", "800.00")]


def test_extraction_is_deterministic():
    assert extract_invoice(IT_INVOICE) == extract_invoice(IT_INVOICE)


def test_missing_invoice_number_lowers_confidence_and_is_listed():
    without_number = EN_INVOICE.replace("Invoice No.: INV-2025-00418\n", "")
    fields = extract_invoice(without_number)
    assert fields.invoice_number is None
    assert "missing:invoice_number" in fields.errors
    assert fields.confidence < 0.5


def test_missing_issue_date_is_listed_and_lowers_confidence():
    fields = extract_invoice(IT_INVOICE.replace("Data: 15/03/2025\n", ""))
    assert fields.issue_date is None
    assert "missing:issue_date" in fields.errors
    assert 0.5 <= fields.confidence < 1.0


def test_tax_id_failing_its_checksum_is_not_accepted_and_is_reported():
    fields = extract_invoice(IT_INVOICE.replace("P.IVA: 99999999990", "P.IVA: 99999999991"))
    assert fields.supplier.tax_id is None
    assert fields.supplier.tax_id_scheme == "unknown"
    assert fields.supplier.name == "Esempio Fornitore S.r.l."
    assert "invalid_tax_id:supplier" in fields.errors
    assert fields.buyer.tax_id == "00000010017"


def test_totals_that_do_not_add_up_are_flagged_and_lower_confidence():
    consistent = extract_invoice(EN_INVOICE)
    skewed = extract_invoice(EN_INVOICE.replace("Total: EUR 1,200.00", "Total: EUR 1,250.00"))
    assert "totals_mismatch" in skewed.errors
    assert "totals_mismatch" not in consistent.errors
    assert skewed.confidence < consistent.confidence


def test_totals_within_one_cent_are_not_a_mismatch():
    fields = extract_invoice(EN_INVOICE.replace("Total: EUR 1,200.00", "Total: EUR 1,200.01"))
    assert "totals_mismatch" not in fields.errors


def test_text_without_invoice_labels_returns_errors_and_zero_confidence():
    fields = extract_invoice("Dear team,\n\nthe warehouse opens at nine. Please bring your badge.\n")
    assert isinstance(fields, InvoiceFields)
    assert fields.confidence == 0.0
    assert "no_invoice_labels" in fields.errors
    assert fields.line_items == []


def test_whitespace_only_input_does_not_raise():
    fields = extract_invoice("   \n")
    assert fields.confidence == 0.0
    assert fields.errors


def test_an_unexpected_failure_is_reported_instead_of_raised(monkeypatch):
    def explode(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(invoice_module, "_extract_fields", explode)
    fields = extract_invoice(EN_INVOICE)
    assert fields.confidence == 0.0
    assert fields.errors == ["extraction_failed"]


@pytest.mark.parametrize("hint", ["en", "it", "zh"])
def test_language_hint_does_not_change_unambiguous_fields(hint):
    assert extract_invoice(EN_INVOICE, language_hint=hint).gross_total == "1200.00"


RECORDED = Path(__file__).resolve().parents[2] / "eval" / "fixtures" / "ingest" / "recorded"


def _recorded_markdown(name: str) -> str:
    return json.loads((RECORDED / f"{name}.parse.json").read_text(encoding="utf-8"))["markdown"]


def _merge_adjacent_lines(markdown: str) -> str:
    """What real Docling does to short Latin lines: a run of plain paragraphs comes back as one space-joined line."""
    blocks: list[str] = []
    run: list[str] = []
    for block in markdown.split("\n\n"):
        text = block.strip()
        if text and not text.startswith(("#", "|")):
            run.append(" ".join(text.split()))
            continue
        if run:
            blocks.append(" ".join(run))
            run = []
        if text:
            blocks.append(text)
    if run:
        blocks.append(" ".join(run))
    return "\n\n".join(blocks)


def test_the_merged_sample_really_has_several_labels_on_one_line():
    merged = _merge_adjacent_lines(_recorded_markdown("invoice-en"))
    header = next(line for line in merged.splitlines() if line.startswith("Invoice No."))
    assert "Invoice date:" in header and "Supplier:" in header and "Bill to:" in header


def test_merged_english_lines_still_yield_every_field():
    fields = extract_invoice(_merge_adjacent_lines(_recorded_markdown("invoice-en")))
    assert fields.invoice_number == "INV-2025-00418"
    assert fields.issue_date == date(2025, 3, 15)
    assert fields.due_date == date(2025, 4, 14)
    assert fields.supplier.name == "Example Supplier Ltd"
    assert (fields.supplier.tax_id, fields.supplier.tax_id_scheme) == ("BE0000000097", "eu_vat")
    assert fields.buyer.name == "Example Buyer GmbH"
    assert (fields.buyer.tax_id, fields.buyer.tax_id_scheme) == ("FR00000000093", "eu_vat")
    assert fields.currency == "EUR"
    assert (fields.net_total, fields.tax_total, fields.gross_total) == ("1000.00", "200.00", "1200.00")
    assert len(fields.line_items) == 2
    assert fields.errors == []
    assert fields.confidence == 1.0


def test_merged_italian_lines_still_yield_every_field():
    fields = extract_invoice(_merge_adjacent_lines(_recorded_markdown("invoice-it")))
    assert fields.invoice_number == "FT-2025-00419"
    assert fields.issue_date == date(2025, 3, 15)
    assert fields.due_date == date(2025, 4, 14)
    assert fields.supplier.name == "Esempio Fornitore S.r.l."
    assert (fields.supplier.tax_id, fields.supplier.tax_id_scheme) == ("99999999990", "it_iva")
    assert fields.buyer.name == "Esempio Cliente S.p.A."
    assert (fields.buyer.tax_id, fields.buyer.tax_id_scheme) == ("00000010017", "it_iva")
    assert fields.currency == "EUR"
    assert (fields.net_total, fields.tax_total, fields.gross_total) == ("1000.00", "220.00", "1220.00")
    assert len(fields.line_items) == 2
    assert fields.errors == []
    assert fields.confidence == 1.0


def test_chinese_stays_at_full_confidence():
    fields = extract_invoice(_recorded_markdown("invoice-zh"))
    assert fields.confidence == 1.0
    assert fields.invoice_number == "FP-2025-00417"
    assert fields.supplier.name == "示例销售有限公司"
    assert fields.buyer.name == "示例买方有限公司"
    assert fields.gross_total == "1130.00"


@pytest.mark.parametrize("name", ["invoice-en", "invoice-it"])
def test_merging_lines_does_not_change_the_result(name):
    markdown = _recorded_markdown(name)
    assert extract_invoice(_merge_adjacent_lines(markdown)) == extract_invoice(markdown)


def test_a_colon_inside_a_value_is_not_a_label():
    merged = "Supplier: Example: Holdings Ltd VAT No.: BE0000000097 Invoice No.: INV-1"
    fields = extract_invoice(merged)
    assert fields.supplier.name == "Example: Holdings Ltd"
    assert fields.supplier.tax_id == "BE0000000097"
    assert fields.invoice_number == "INV-1"


def test_a_long_merged_line_is_read_and_a_hostile_one_is_skipped_quickly():
    padding = "Example Supplier Holding Company " * 20
    fields = extract_invoice(f"Supplier: {padding}Ltd Invoice No.: INV-9 Total: EUR 5.00")
    assert fields.invoice_number == "INV-9"
    assert fields.gross_total == "5.00"

    started = time.monotonic()
    hostile = extract_invoice("Invoice No.: INV-9 " + "a: b " * 40_000)
    assert time.monotonic() - started < 2.0
    assert hostile.invoice_number is None


def _client() -> TestClient:
    return TestClient(create_app(SidecarSettings(secret=SecretStr(SECRET))))


def test_route_without_the_secret_header_is_401():
    response = _client().post(ROUTE, json={"markdown": EN_INVOICE})
    assert response.status_code == 401
    assert SidecarError.model_validate(response.json()).error == "unauthorized"


def test_route_with_a_wrong_secret_is_401():
    response = _client().post(ROUTE, json={"markdown": EN_INVOICE}, headers={HEADER: "wrong"})
    assert response.status_code == 401


def test_route_returns_invoice_fields_for_a_valid_request():
    response = _client().post(ROUTE, json={"markdown": IT_INVOICE, "language_hint": "it"}, headers={HEADER: SECRET})
    assert response.status_code == 200
    fields = InvoiceFields.model_validate(response.json())
    assert fields == extract_invoice(IT_INVOICE, language_hint="it")
    assert fields.invoice_number == "FT-2025-00419"
    assert fields.gross_total == "1220.00"


def test_route_reads_the_tables_field():
    table = "| Description | Qty | Unit price | Amount |\n| --- | --- | --- | --- |\n| Thermal probe | 8 | 100.00 | 800.00 |\n"
    response = _client().post(ROUTE, json={"markdown": "Total: EUR 800.00\n", "tables": [table]}, headers={HEADER: SECRET})
    assert response.status_code == 200
    assert [item["amount"] for item in response.json()["line_items"]] == ["800.00"]


def test_route_unreadable_input_is_200_with_errors_and_zero_confidence():
    response = _client().post(ROUTE, json={"markdown": "no labels here at all"}, headers={HEADER: SECRET})
    assert response.status_code == 200
    body = response.json()
    assert body["confidence"] == 0.0
    assert body["errors"]


@pytest.mark.parametrize(
    "payload",
    [{}, {"markdown": ""}, {"markdown": 5}, {"markdown": "x", "unknown": 1}, {"markdown": "x", "language_hint": "fr"}],
)
def test_route_invalid_body_is_422_with_a_sidecar_error(payload):
    response = _client().post(ROUTE, json=payload, headers={HEADER: SECRET})
    assert response.status_code == 422
    assert SidecarError.model_validate(response.json()).error == "invalid_invoice_request"


def test_route_non_json_body_is_422():
    response = _client().post(ROUTE, content=b"not json", headers={HEADER: SECRET, "content-type": "application/json"})
    assert response.status_code == 422
    assert SidecarError.model_validate(response.json()).error == "invalid_invoice_request"


def test_route_markdown_over_two_million_characters_is_413():
    response = _client().post(ROUTE, json={"markdown": "a" * 2_000_001}, headers={HEADER: SECRET})
    assert response.status_code == 413
    assert SidecarError.model_validate(response.json()).error == "invoice_too_large"


def test_route_body_declared_far_over_the_cap_is_413_before_it_is_read():
    response = _client().post(
        ROUTE, content=b"{}", headers={HEADER: SECRET, "content-type": "application/json", "content-length": str(64 * 1024 * 1024)}
    )
    assert response.status_code == 413


def test_route_cap_counts_characters_so_multibyte_text_under_it_is_accepted():
    response = _client().post(ROUTE, json={"markdown": "票" * 1_000_000}, headers={HEADER: SECRET})
    assert response.status_code == 200
