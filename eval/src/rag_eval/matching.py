from rag_sidecar.contracts.golden import GoldSpan


def normalize_text(s: str) -> str:
    return s


def chunk_matches_span(document_name: str, chunk_text: str, span: GoldSpan) -> bool:
    return False
