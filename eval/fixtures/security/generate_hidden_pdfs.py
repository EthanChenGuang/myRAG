"""Deterministic generator for the hidden-text PDF fixtures (plan 03.2-35, D-33, D-46).

Run from the repository root:

    python3 eval/fixtures/security/generate_hidden_pdfs.py --out eval/fixtures/security/pdf

The PDFs are written by hand with the standard library only: uncompressed content streams, no dates, no
document id, the built-in Helvetica font (WinAnsi) for en and it, and the non-embedded STSong-Light CID font
(UniGB-UCS2-H) for zh. The same code gives the same bytes on every machine, and the sidecar tests rebuild
them without reportlab. All text is neutral synthetic prose.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

A4 = (595.0, 842.0)
BLACK = (0.0, 0.0, 0.0)
WHITE = (1.0, 1.0, 1.0)

VISIBLE_EN = (
    "The quarterly review lists three open items for the team.",
    "Each item has an owner and a target date in the next cycle.",
    "Progress is reported at the start of every weekly meeting.",
)
VISIBLE_IT = (
    "Il documento descrive le fasi principali del progetto.",
    "Ogni fase ha un responsabile e una data di consegna.",
    "Il riepilogo viene aggiornato alla fine di ogni mese.",
)
VISIBLE_ZH = (
    "本文件介绍项目的主要阶段和每个阶段的目标。",
    "每个阶段都有负责人和计划完成日期。",
    "进度在每周例会开始时汇报一次。",
)

HIDDEN_SENTENCE = {
    "white-on-white": "This sentence is written in white on a white page.",
    "tiny-font": "这一句用极小的字号写成读者看不见。",
    "off-page": "Questa frase si trova fuori dal bordo della pagina.",
    "invisible-render": "This sentence uses the invisible text render mode.",
    "covered-text": "Questa frase viene coperta da un rettangolo bianco.",
}
LINK_TARGET = "https://example.org/reference/overview"


@dataclass
class Page:
    width: float = A4[0]
    height: float = A4[1]
    crop: tuple[float, float, float, float] | None = None
    ops: list[bytes] = field(default_factory=list)
    links: list[tuple[tuple[float, float, float, float], str]] = field(default_factory=list)
    uses_image: bool = False

    def text(
        self,
        x: float,
        y: float,
        value: str,
        size: float = 11.0,
        fill: tuple[float, float, float] = BLACK,
        mode: int = 0,
    ) -> Page:
        font, encoded = _encode(value)
        self.ops.append(
            b"q %s rg BT %d Tr /%s %s Tf %s %s Td %s Tj ET Q"
            % (_rgb(fill), mode, font, _num(size), _num(x), _num(y), encoded)
        )
        return self

    def rect(self, x: float, y: float, w: float, h: float, fill: tuple[float, float, float]) -> Page:
        self.ops.append(b"q %s rg %s %s %s %s re f Q" % (_rgb(fill), _num(x), _num(y), _num(w), _num(h)))
        return self

    def stroke_line(self, x0: float, y0: float, x1: float, y1: float, width: float = 0.5) -> Page:
        self.ops.append(b"q 0 G %s w %s %s m %s %s l S Q" % (_num(width), _num(x0), _num(y0), _num(x1), _num(y1)))
        return self

    def image(self, x: float, y: float, w: float, h: float) -> Page:
        self.uses_image = True
        self.ops.append(b"q %s 0 0 %s %s %s cm /Im1 Do Q" % (_num(w), _num(h), _num(x), _num(y)))
        return self

    def link(self, rect: tuple[float, float, float, float], uri: str) -> Page:
        self.links.append((rect, uri))
        return self


def _num(value: float) -> bytes:
    text = f"{value:.3f}".rstrip("0").rstrip(".")
    return (text if text not in ("", "-0") else "0").encode("ascii")


def _rgb(color: tuple[float, float, float]) -> bytes:
    return b" ".join(_num(part) for part in color)


def _encode(value: str) -> tuple[bytes, bytes]:
    try:
        raw = value.encode("cp1252")
    except UnicodeEncodeError:
        return b"F2", b"<" + value.encode("utf-16-be").hex().upper().encode("ascii") + b">"
    escaped = raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
    return b"F1", b"(" + escaped + b")"


# A 4x4 grey-scale checker, stored raw: an image-only page with no text layer.
_IMAGE_PIXELS = bytes([0x30, 0xD0, 0x30, 0xD0, 0xD0, 0x30, 0xD0, 0x30] * 2)


def write_pdf(pages: list[Page]) -> bytes:
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    catalog = add(b"")
    pages_ref = add(b"")
    helvetica = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    descriptor = add(
        b"<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880]"
        b" /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>"
    )
    cid = add(
        b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light"
        b" /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor %d 0 R /DW 1000 >>"
        % descriptor
    )
    song = add(
        b"<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [%d 0 R] >>"
        % cid
    )
    image = add(
        b"<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8"
        b" /Length %d >>\nstream\n" % len(_IMAGE_PIXELS) + _IMAGE_PIXELS + b"\nendstream"
    )
    kids: list[int] = []
    for page in pages:
        content = b"\n".join(page.ops)
        stream = add(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
        annots: list[int] = []
        for (x0, y0, x1, y1), uri in page.links:
            annots.append(
                add(
                    b"<< /Type /Annot /Subtype /Link /Rect [%s %s %s %s] /Border [0 0 0] /A << /S /URI /URI (%s) >> >>"
                    % (_num(x0), _num(y0), _num(x1), _num(y1), uri.encode("ascii"))
                )
            )
        resources = b"<< /Font << /F1 %d 0 R /F2 %d 0 R >>" % (helvetica, song)
        if page.uses_image:
            resources += b" /XObject << /Im1 %d 0 R >>" % image
        resources += b" >>"
        body = b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %s %s]" % (
            pages_ref,
            _num(page.width),
            _num(page.height),
        )
        if page.crop is not None:
            body += b" /CropBox [%s]" % b" ".join(_num(value) for value in page.crop)
        body += b" /Resources %s /Contents %d 0 R" % (resources, stream)
        if annots:
            body += b" /Annots [%s]" % b" ".join(b"%d 0 R" % ref for ref in annots)
        body += b" >>"
        kids.append(add(body))
    objects[catalog - 1] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages_ref
    objects[pages_ref - 1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % ref for ref in kids),
        len(kids),
    )

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, catalog, xref)
    return bytes(out)


def _paragraph(page: Page, lines: tuple[str, ...], top: float, size: float = 11.0, leading: float = 16.0) -> float:
    y = top
    for line in lines:
        page.text(72, y, line, size=size)
        y -= leading
    return y


def _around(lines: tuple[str, ...], hidden: tuple[float, float, str, dict]) -> Page:
    """Visible lines, the hidden sentence in the middle, more visible lines after it."""
    page = Page()
    y = _paragraph(page, lines[:2], 760)
    x, dy, value, style = hidden
    page.text(x, y - dy, value, **style)
    _paragraph(page, lines[2:], y - 16)
    return page


def white_on_white() -> bytes:
    return write_pdf([_around(VISIBLE_EN, (72, 0, HIDDEN_SENTENCE["white-on-white"], {"fill": WHITE}))])


def clean_plain() -> bytes:
    page = Page()
    _paragraph(page, VISIBLE_EN + VISIBLE_IT, 760)
    return write_pdf([page])


def tiny_font() -> bytes:
    return write_pdf([_around(VISIBLE_ZH, (72, 0, HIDDEN_SENTENCE["tiny-font"], {"size": 1.0}))])


def off_page() -> bytes:
    page = Page()
    _paragraph(page, VISIBLE_IT, 760)
    page.text(72, -120, HIDDEN_SENTENCE["off-page"])
    return write_pdf([page])


def invisible_render() -> bytes:
    return write_pdf([_around(VISIBLE_EN, (72, 0, HIDDEN_SENTENCE["invisible-render"], {"mode": 3}))])


def covered_text() -> bytes:
    page = Page()
    y = _paragraph(page, VISIBLE_IT[:2], 760)
    page.text(72, y, HIDDEN_SENTENCE["covered-text"])
    page.rect(68, y - 5, 440, 18, WHITE)
    _paragraph(page, VISIBLE_IT[2:], y - 16)
    return write_pdf([page])


def clean_dark_header() -> bytes:
    page = Page()
    page.text(72, 780, "Summary table of the review items", size=14)
    columns = (72.0, 232.0, 392.0)
    widths = 160.0
    header = ("Item", "Owner", "Target date")
    rows = (("First item", "Team A", "Week 3"), ("Second item", "Team B", "Week 5"), ("Third item", "Team C", "Week 8"))
    top = 740.0
    page.rect(72, top - 6, widths * 3, 22, (0.13, 0.2, 0.33))
    for x, label in zip(columns, header):
        page.text(x + 6, top, label, size=11, fill=WHITE)
    for index, row in enumerate(rows):
        y = top - 22 * (index + 1)
        if index % 2 == 1:
            page.rect(72, y - 6, widths * 3, 22, (0.93, 0.93, 0.93))
        for x, value in zip(columns, row):
            page.text(x + 6, y, value, size=10.5)
    for index in range(len(rows) + 2):
        y = top + 16 - 22 * index
        page.stroke_line(72, y, 72 + widths * 3, y)
    page.text(72, top - 22 * (len(rows) + 2), "Light grey rows alternate with white rows.", size=10.5)
    return write_pdf([page])


def clean_footnotes() -> bytes:
    page = Page()
    y = 760.0
    for index, line in enumerate(VISIBLE_ZH + VISIBLE_EN):
        page.text(72, y, line, size=10.5)
        page.text(72 + 20 + 10.5 * (len(line) if index < 3 else len(line) / 2), y + 4, str(index + 1), size=5.5)
        y -= 16
    page.stroke_line(72, 90, 200, 90)
    page.text(72, 78, "1 本页脚注说明正文中第一个标记。", size=7)
    page.text(72, 68, "2 The second marker refers to the weekly meeting notes.", size=7)
    page.text(72, 58, "3 Il terzo segno rimanda al riepilogo mensile.", size=7)
    return write_pdf([page])


def clean_crop_marks() -> bytes:
    page = Page(crop=(36, 36, 559, 806))
    _paragraph(page, VISIBLE_EN, 760)
    for x, y in ((36, 36), (559, 36), (36, 806), (559, 806)):
        sign_x = -1 if x < 300 else 1
        sign_y = -1 if y < 400 else 1
        page.stroke_line(x + sign_x * 6, y, x + sign_x * 30, y, width=0.25)
        page.stroke_line(x, y + sign_y * 6, x, y + sign_y * 30, width=0.25)
    page.rect(10, 10, 12, 12, (0.0, 0.6, 0.9))
    return write_pdf([page])


def clean_scan() -> bytes:
    return write_pdf([Page().image(0, 0, A4[0], A4[1])])


def clean_ocr_layer() -> bytes:
    page = Page().image(40, 600, 515, 200)
    y = 760.0
    for line in VISIBLE_EN:
        page.text(60, y, line, size=11, mode=3)
        y -= 20
    return write_pdf([page])


def zero_pages() -> bytes:
    return write_pdf([])


def link_annotation() -> bytes:
    page = Page()
    _paragraph(page, VISIBLE_EN, 760)
    page.text(72, 700, "See the reference overview for details.", size=11)
    page.link((72, 696, 300, 712), LINK_TARGET)
    return write_pdf([page])


# Built in tests only, not written to the corpus.
def many_fragments(count: int, per_page: int = 50) -> bytes:
    """`count` white fragments, each followed by a visible one so no two hidden fragments merge."""
    pages: list[Page] = []
    for index in range(count):
        if index % per_page == 0:
            pages.append(Page())
        page = pages[-1]
        y = 800 - (index % per_page) * 15
        page.text(72, y, f"hidden fragment {index:04d}", size=8, fill=WHITE)
        page.text(320, y, f"visible line {index:04d}", size=8)
    return write_pdf(pages)


def long_span(chars: int, per_line: int = 100) -> bytes:
    page = Page()
    page.text(72, 810, VISIBLE_EN[0], size=8)
    body = ("abcdefghij" * (chars // 10 + 1))[:chars]
    y = 800.0
    for start in range(0, chars, per_line):
        page.text(20, y, body[start : start + per_line], size=6, fill=WHITE)
        y -= 7
    return write_pdf([page])


def short_fragment() -> bytes:
    page = Page()
    _paragraph(page, VISIBLE_EN, 760)
    page.text(72, 600, "ab", fill=WHITE)
    return write_pdf([page])


HIDDEN_FIXTURES = {
    "white-on-white.pdf": (white_on_white, "color_near_background"),
    "tiny-font.pdf": (tiny_font, "font_too_small"),
    "off-page.pdf": (off_page, "outside_page"),
    "invisible-render.pdf": (invisible_render, "invisible_render_mode"),
    "covered-text.pdf": (covered_text, "covered_by_object"),
}
CLEAN_FIXTURES = {
    "clean-plain.pdf": clean_plain,
    "clean-dark-header.pdf": clean_dark_header,
    "clean-footnotes.pdf": clean_footnotes,
    "clean-crop-marks.pdf": clean_crop_marks,
    "clean-scan.pdf": clean_scan,
    "clean-ocr-layer.pdf": clean_ocr_layer,
    "link-annotation.pdf": link_annotation,
    "zero-pages.pdf": zero_pages,
}


def build_fixtures() -> dict[str, bytes]:
    built = {name: build() for name, (build, _) in HIDDEN_FIXTURES.items()}
    built.update({name: build() for name, build in CLEAN_FIXTURES.items()})
    return dict(sorted(built.items()))


def manifest(built: dict[str, bytes]) -> dict:
    return {
        "generator": "eval/fixtures/security/generate_hidden_pdfs.py",
        "fixtures": {
            name: {
                "sha256": hashlib.sha256(data).hexdigest(),
                "expected": "hidden_found" if name in HIDDEN_FIXTURES else "clean",
                "reason": HIDDEN_FIXTURES[name][1] if name in HIDDEN_FIXTURES else None,
                "hidden_text": HIDDEN_SENTENCE.get(name.removesuffix(".pdf")),
            }
            for name, data in built.items()
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "pdf")
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    built = build_fixtures()
    for name, data in built.items():
        (args.out / name).write_bytes(data)
    (args.out / "manifest.json").write_text(
        json.dumps(manifest(built), ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
