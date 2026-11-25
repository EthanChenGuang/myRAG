from pathlib import Path

from rag_sidecar.preflight.config import load_routing_config
from rag_sidecar.preflight.l1 import EncryptedPdf, l1_signals

MIN_TEXT_CHARS = 10


def text_layer_page_share(path: Path, max_pages: int | None = None) -> float | None:
    """Share of pages whose PDF text layer holds more than a few characters.

    Best effort: None when pypdfium2 is not installed, the file cannot be read, or the document has
    more pages than max_pages (the conversion rejects it anyway, so its pages are not walked).
    """
    try:
        import pypdfium2  # noqa: F401
    except ImportError:
        return None
    try:
        cfg = load_routing_config()
        result = l1_signals(path, cfg)
    except EncryptedPdf:
        return None
    except Exception:
        try:
            import pypdfium2 as pdfium
        except ImportError:
            return None
        return _legacy_text_layer_share(path, max_pages, pdfium)

    if len(result.pages) == 0:
        return None
    if max_pages is not None and len(result.pages) > max_pages:
        return None
    with_text = sum(1 for page in result.pages if page.text_layer)
    return with_text / len(result.pages)


def _legacy_text_layer_share(path: Path, max_pages: int | None, pdfium) -> float | None:
    try:
        document = pdfium.PdfDocument(str(path))
    except (pdfium.PdfiumError, OSError, ValueError):
        return None
    try:
        count = len(document)
        if count == 0 or (max_pages is not None and count > max_pages):
            return None
        with_text = 0
        for index in range(count):
            page = document[index]
            try:
                text_page = page.get_textpage()
                try:
                    if len(text_page.get_text_range().strip()) >= MIN_TEXT_CHARS:
                        with_text += 1
                finally:
                    text_page.close()
            finally:
                page.close()
        return with_text / count
    except (pdfium.PdfiumError, OSError, ValueError):
        return None
    finally:
        document.close()