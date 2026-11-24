from pathlib import Path

MIN_TEXT_CHARS = 10


def text_layer_page_share(path: Path, max_pages: int | None = None) -> float | None:
    """Share of pages whose PDF text layer holds more than a few characters.

    Best effort: None when pypdfium2 is not installed, the file cannot be read, or the document has
    more pages than max_pages (the conversion rejects it anyway, so its pages are not walked).
    """
    try:
        import pypdfium2
    except ImportError:
        return None
    try:
        document = pypdfium2.PdfDocument(str(path))
    except (pypdfium2.PdfiumError, OSError, ValueError):
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
    except (pypdfium2.PdfiumError, OSError, ValueError):
        return None
    finally:
        document.close()
