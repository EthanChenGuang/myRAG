"""Deterministic generator for the typed ingestion fixture PDFs.

Run from the repository root:

    uv run --directory eval --extra fixtures python fixtures/ingest/generate_pdfs.py --out fixtures/ingest/pdf

Digital PDFs are built with reportlab in invariant mode, uncompressed, with the built-in STSong-Light
CID font for Chinese, so the same code gives the same bytes on every machine. Scanned PDFs are page
images rendered with Pillow and a CJK font given by --cjk-font and stored as JPEG, so they carry no text
layer; the font's sha256 goes into build-info.json next to the PDFs, and their bytes are only comparable
on a machine that has that font. Markdown for the text path is written next to the PDFs (--text-out).
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import re
import sys
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

MARGIN_X = 56.7
MARGIN_TOP = 60.0
MARGIN_BOTTOM = 60.0
HEADING_STYLES = {1: (20.0, 26.0), 2: (15.0, 20.0), 3: (12.5, 17.0)}
BODY_STYLE = (10.5, 15.5)
SCAN_DPI = 200
SCAN_JPEG_QUALITY = 90
SCAN_HEADING_PX = {1: 62, 2: 50, 3: 44}
SCAN_BODY_PX = 38
SCAN_MARGIN_PX = 160
CJK_CHAR = re.compile(r"[㐀-䶿一-鿿]")


class LayoutError(RuntimeError):
    """A block does not fit on its page; the spec or the layout constants must change."""


def _specs() -> Any:
    loaded = sys.modules.get("ingest_fixture_specs")
    if loaded is not None:
        return loaded
    spec = importlib.util.spec_from_file_location("ingest_fixture_specs", Path(__file__).resolve().parent / "specs.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _display_width(text: str) -> float:
    return sum(2.0 if CJK_CHAR.match(char) else 1.0 for char in text)


def _column_widths(rows: tuple[tuple[str, ...], ...], total: float) -> list[float]:
    weights = [max(max(_display_width(row[column]) for row in rows), 4.0) + 3.0 for column in range(len(rows[0]))]
    scale = total / sum(weights)
    return [weight * scale for weight in weights]


def build_digital(spec: Any) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas
    from reportlab.platypus import Paragraph, Table, TableStyle

    from PIL import Image

    specs = _specs()
    zh = spec.language == "zh"
    if zh:
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    body_font = "STSong-Light" if zh else "Helvetica"
    heading_font = "STSong-Light" if zh else "Helvetica-Bold"
    content_width = specs.PAGE_WIDTH - 2 * MARGIN_X

    def style(name: str, font: str, size: float, leading: float, **extra: Any) -> ParagraphStyle:
        return ParagraphStyle(name=name, fontName=font, fontSize=size, leading=leading, wordWrap="CJK" if zh else None, **extra)

    body = style("body", body_font, *BODY_STYLE)
    item = style("item", body_font, *BODY_STYLE, leftIndent=18)
    caption = style("caption", body_font, 9.0, 13.0, alignment=1)
    headings = {level: style(f"h{level}", heading_font, size, leading) for level, (size, leading) in HEADING_STYLES.items()}

    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(specs.PAGE_WIDTH, specs.PAGE_HEIGHT), invariant=1, pageCompression=0)
    pdf.setTitle(spec.id)
    pdf.setAuthor("myRAG synthetic fixtures")
    pdf.setSubject("Synthetic ingestion fixture")

    page = 1
    y = specs.PAGE_HEIGHT - MARGIN_TOP

    def place(flowable: Any, gap_before: float, gap_after: float, width: float = content_width, x: float = MARGIN_X) -> None:
        nonlocal y
        _, height = flowable.wrap(width, specs.PAGE_HEIGHT)
        top = y - gap_before
        if top - height < MARGIN_BOTTOM:
            raise LayoutError(f"{spec.id}: a block of height {height:.0f} does not fit on page {page}")
        flowable.drawOn(pdf, x, top - height)
        y = top - height - gap_after

    for block in spec.blocks:
        while block.page > page:
            pdf.showPage()
            page += 1
            y = specs.PAGE_HEIGHT - MARGIN_TOP
        if isinstance(block, specs.Heading):
            place(Paragraph(escape(block.text), headings[block.level]), 10.0, 4.0)
        elif isinstance(block, specs.Paragraph):
            place(Paragraph(escape(block.text), body), 0.0, 6.0)
        elif isinstance(block, specs.ListItem):
            place(Paragraph(escape(block.marker + block.text), item), 0.0, 3.0)
        elif isinstance(block, specs.Table):
            size = 8.0 if len(block.rows) > 20 else 9.5
            table = Table([list(row) for row in block.rows], colWidths=_column_widths(block.rows, content_width))
            commands: list[tuple[Any, ...]] = [
                ("FONT", (0, 0), (-1, -1), body_font, size),
                ("FONT", (0, 0), (-1, 0), heading_font, size),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e6e6e6")),
                ("TOPPADDING", (0, 0), (-1, -1), 2.0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.0),
            ]
            table.setStyle(TableStyle(commands))
            place(table, 4.0, 10.0)
        elif isinstance(block, specs.Picture):
            width_px, height_px = specs.PICTURE_PIXELS
            picture = Image.frombytes("RGB", (width_px, height_px), specs.picture_rgb(block.name))
            jpeg = io.BytesIO()
            picture.save(jpeg, format="JPEG", quality=92, optimize=False, progressive=False)
            width_pt, height_pt = specs.PICTURE_SIZE_PT
            top = y - 6.0
            if top - height_pt < MARGIN_BOTTOM:
                raise LayoutError(f"{spec.id}: the picture does not fit on page {page}")
            pdf.drawImage(ImageReader(io.BytesIO(jpeg.getvalue())), (specs.PAGE_WIDTH - width_pt) / 2, top - height_pt, width=width_pt, height=height_pt)
            y = top - height_pt - 4.0
            place(Paragraph(escape(block.caption), caption), 0.0, 8.0)
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def _tokens(text: str) -> list[str]:
    if CJK_CHAR.search(text):
        return re.findall(r"[A-Za-z0-9][A-Za-z0-9\-./]*\s*|.", text)
    return re.findall(r"\S+\s*", text)


def _wrap(draw: Any, text: str, font: Any, max_width: float) -> list[str]:
    lines: list[str] = []
    current = ""
    for token in _tokens(text):
        if current and draw.textlength((current + token).rstrip(), font=font) > max_width:
            lines.append(current.rstrip())
            current = token
        else:
            current += token
    if current.strip():
        lines.append(current.rstrip())
    return lines


def build_scanned(spec: Any, font_path: Path, font_index: int = 0) -> bytes:
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    from PIL import Image, ImageDraw, ImageFont

    specs = _specs()
    width_px = round(specs.PAGE_WIDTH / 72 * SCAN_DPI)
    height_px = round(specs.PAGE_HEIGHT / 72 * SCAN_DPI)
    image = Image.new("L", (width_px, height_px), 255)
    draw = ImageDraw.Draw(image)
    y = SCAN_MARGIN_PX
    page = 1
    for block in spec.blocks:
        if block.page != page:
            raise LayoutError(f"{spec.id}: scanned fixtures are single page")
        if isinstance(block, specs.Heading):
            size = SCAN_HEADING_PX[block.level]
            gap_before = 50
        elif isinstance(block, specs.Paragraph):
            size = SCAN_BODY_PX
            gap_before = 0
        else:
            raise LayoutError(f"{spec.id}: scanned fixtures hold headings and paragraphs only")
        font = ImageFont.truetype(str(font_path), size, index=font_index)
        y += gap_before
        for line in _wrap(draw, block.text, font, width_px - 2 * SCAN_MARGIN_PX):
            if y + size > height_px - SCAN_MARGIN_PX:
                raise LayoutError(f"{spec.id}: the text does not fit on the page")
            draw.text((SCAN_MARGIN_PX, y), line, fill=0, font=font)
            y += round(size * 1.55)
        y += 24
    jpeg = io.BytesIO()
    image.save(jpeg, format="JPEG", quality=SCAN_JPEG_QUALITY, optimize=False, progressive=False, dpi=(SCAN_DPI, SCAN_DPI))
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(specs.PAGE_WIDTH, specs.PAGE_HEIGHT), invariant=1, pageCompression=0)
    pdf.setTitle(spec.id)
    pdf.setAuthor("myRAG synthetic fixtures")
    pdf.setSubject("Synthetic ingestion fixture (scan)")
    pdf.drawImage(ImageReader(io.BytesIO(jpeg.getvalue())), 0, 0, width=specs.PAGE_WIDTH, height=specs.PAGE_HEIGHT)
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def _build_info(font_path: Path, font_index: int) -> dict[str, Any]:
    from importlib.metadata import version

    from PIL import ImageFont

    family, style = ImageFont.truetype(str(font_path), 20, index=font_index).getname()
    return {
        "generator": {"reportlab": version("reportlab"), "pillow": version("pillow"), "render_dpi": SCAN_DPI},
        "scan_font": {"family": family, "style": style, "sha256": sha256_hex(font_path.read_bytes()), "index": font_index},
    }


def generate(out_dir: Path, text_dir: Path, cjk_font: Path | None, font_index: int = 0) -> dict[str, str]:
    """Writes every PDF it can build (the scans need cjk_font) and the Markdown files; returns id to sha256."""
    specs = _specs()
    out_dir.mkdir(parents=True, exist_ok=True)
    text_dir.mkdir(parents=True, exist_ok=True)
    written: dict[str, str] = {}
    for spec in specs.all_specs():
        if spec.layer == "digital":
            data = build_digital(spec)
        elif cjk_font is not None:
            data = build_scanned(spec, cjk_font, font_index)
        else:
            continue
        (out_dir / f"{spec.id}.pdf").write_bytes(data)
        written[spec.id] = sha256_hex(data)
        if spec.write_text:
            (text_dir / f"{spec.id}.md").write_text(specs.render_markdown(spec), encoding="utf-8")
    if cjk_font is not None:
        info = json.dumps(_build_info(cjk_font, font_index), indent=2, sort_keys=True) + "\n"
        (out_dir / "build-info.json").write_text(info, encoding="utf-8")
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--target", choices=("ingest", "parse"), default="ingest", help="fixture set to generate")
    parser.add_argument("--out", type=Path, default=None, help="output directory (required for ingest target; parse target defaults to fixtures/parse)")
    parser.add_argument("--text-out", type=Path, default=None, help="directory for the Markdown files (default: ../text next to --out)")
    parser.add_argument("--cjk-font", type=Path, default=None, help="CJK font file used to render the scanned fixtures")
    parser.add_argument("--cjk-font-index", type=int, default=0, help="face index inside a font collection")
    args = parser.parse_args(argv)
    if args.target == "parse":
        parse_generate = importlib.util.spec_from_file_location(
            "parse_generate",
            Path(__file__).resolve().parents[1] / "parse" / "generate_parse.py",
        )
        assert parse_generate is not None and parse_generate.loader is not None
        module = importlib.util.module_from_spec(parse_generate)
        parse_generate.loader.exec_module(module)
        if args.cjk_font is not None and not args.cjk_font.is_file():
            parser.error(f"--cjk-font {args.cjk_font} is not a file")
        module.generate(args.cjk_font, args.cjk_font_index, args.out)
        return 0
    if args.out is None:
        parser.error("--out is required for ingest target")
    text_out = args.text_out or args.out.resolve().parent / "text"
    if args.cjk_font is not None and not args.cjk_font.is_file():
        parser.error(f"--cjk-font {args.cjk_font} is not a file")
    written = generate(args.out, text_out, args.cjk_font, args.cjk_font_index)
    for spec_id, digest in sorted(written.items()):
        print(f"{spec_id}.pdf {digest}")
    if args.cjk_font is None:
        print("notice: scanned PDFs skipped, pass --cjk-font to render them", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
