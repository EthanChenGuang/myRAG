from rag_sidecar.contracts.ingest import InvoiceFields, OcrLanguage


def _extract_fields(markdown: str, tables: list[str], language_hint: OcrLanguage | None) -> InvoiceFields:
    return InvoiceFields(confidence=0.0, errors=["not_implemented"])


def extract_invoice(
    markdown: str, tables: list[str] | None = None, language_hint: OcrLanguage | None = None
) -> InvoiceFields:
    return InvoiceFields(confidence=0.0, errors=["not_implemented"])
