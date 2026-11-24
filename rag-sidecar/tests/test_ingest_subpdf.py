"""Tests for premium sub-PDF extraction."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

pypdfium2 = pytest.importorskip("pypdfium2")

from rag_sidecar.ingest.subpdf import cut_subpdf  # noqa: E402


def _pdf_bytes(page_texts: list[str]) -> bytes:
    count = len(page_texts)
    kids = " ".join(f"{4 + 2 * index} 0 R" for index in range(count))
    bodies = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {count} >>".encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for index, text in enumerate(page_texts):
        content = f"BT /F1 18 Tf 72 700 Td ({text}) Tj ET".encode() if text else b""
        bodies.append(
            (
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 3 0 R >> >> /Contents {5 + 2 * index} 0 R >>"
            ).encode()
        )
        bodies.append(f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(bodies, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(bodies) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(bodies) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def _page_text(path: Path, page_index: int) -> str:
    document = pypdfium2.PdfDocument(str(path))
    try:
        page = document[page_index]
        textpage = page.get_textpage()
        text = textpage.get_text_bounded()
        textpage.close()
        return text.replace("\r\n", "\n").strip()
    finally:
        document.close()


def test_cut_subpdf_extracts_exact_pages_and_maps_sub_indices():
    labels = [f"PAGE-{index}" for index in range(1, 101)]
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        source = root / "source.pdf"
        source.write_bytes(_pdf_bytes(labels))
        target = root / "subset.pdf"
        mapping = cut_subpdf(source, [3, 57, 99], target)
        assert mapping == {1: 3, 2: 57, 3: 99}
        assert len(pypdfium2.PdfDocument(str(target))) == 3
        assert _page_text(target, 0) == "PAGE-3"
        assert _page_text(target, 1) == "PAGE-57"
        assert _page_text(target, 2) == "PAGE-99"
        leftovers = list(root.glob("*.tmp"))
        assert leftovers == []


def test_cut_subpdf_rejects_empty_or_out_of_range_pages():
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "source.pdf"
        source.write_bytes(_pdf_bytes(["a", "b"]))
        out = Path(tmp) / "out.pdf"
        with pytest.raises(ValueError):
            cut_subpdf(source, [], out)
        with pytest.raises(ValueError):
            cut_subpdf(source, [0], out)
        with pytest.raises(ValueError):
            cut_subpdf(source, [99], out)