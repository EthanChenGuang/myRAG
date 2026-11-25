"""Cut a sub-PDF containing only selected source pages (D-53 premium billing)."""

from __future__ import annotations

from pathlib import Path

import pypdfium2 as pdfium


def cut_subpdf(src_path: Path | str, pages: list[int], out_path: Path | str) -> dict[int, int]:
    """Write a PDF with exactly ``pages`` from the source and return sub-page → original-page map."""
    if not pages:
        raise ValueError("pages must not be empty")
    src = pdfium.PdfDocument(str(src_path))
    try:
        page_count = len(src)
        for page in pages:
            if page < 1 or page > page_count:
                raise ValueError(f"page {page} outside 1..{page_count}")
        sub = pdfium.PdfDocument.new()
        try:
            sub.import_pages(src, pages=[page - 1 for page in pages])
            sub.save(str(out_path))
        finally:
            sub.close()
    finally:
        src.close()
    return {index + 1: original for index, original in enumerate(pages)}