import unicodedata

from rag_sidecar.contracts.golden import GoldSpan


def normalize_text(s: str) -> str:
    folded = unicodedata.normalize("NFKC", s).casefold()
    return "".join(c for c in folded if not c.isspace() and not unicodedata.category(c).startswith("P"))


def chunk_matches_span(document_name: str, chunk_text: str, span: GoldSpan) -> bool:
    quote = normalize_text(span.quote)
    if not quote:
        raise ValueError("span quote normalizes to empty text")
    if document_name.casefold() != span.document.casefold():
        return False
    return quote in normalize_text(chunk_text)
