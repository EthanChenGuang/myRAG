"""Generate parse fixture PDFs, manifest and expected structure files."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import sys
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
PARSE_PDF = HERE / "pdf"
PARSE_EXPECTED = HERE / "expected"
COLUMN_GAP = 24.0


def _ingest_specs() -> Any:
    loaded = sys.modules.get("ingest_fixture_specs")
    if loaded is not None:
        return loaded
    path = HERE.parent / "ingest" / "specs.py"
    spec = importlib.util.spec_from_file_location("ingest_fixture_specs", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _parse_specs() -> Any:
    path = HERE / "parse_specs.py"
    spec = importlib.util.spec_from_file_location("parse_fixture_specs_module", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _parse_expected_mod() -> Any:
    path = HERE / "parse_expected.py"
    spec = importlib.util.spec_from_file_location("parse_fixture_expected", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _load_generate() -> Any:
    path = HERE.parent / "ingest" / "generate_pdfs.py"
    spec = importlib.util.spec_from_file_location("ingest_generate_pdfs", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _draw_scanned_page(pdf: Any, blocks: tuple[Any, ...], ingest_specs: Any, gen: Any, font_path: Path, font_index: int) -> None:
    from reportlab.lib.utils import ImageReader

    from PIL import Image, ImageDraw, ImageFont

    width_px = round(ingest_specs.PAGE_WIDTH / 72 * gen.SCAN_DPI)
    height_px = round(ingest_specs.PAGE_HEIGHT / 72 * gen.SCAN_DPI)
    image = Image.new("L", (width_px, height_px), 255)
    draw = ImageDraw.Draw(image)
    y = gen.SCAN_MARGIN_PX
    for block in blocks:
        if isinstance(block, ingest_specs.Heading):
            size = gen.SCAN_HEADING_PX[block.level]
            gap_before = 50
        elif isinstance(block, ingest_specs.Paragraph):
            size = gen.SCAN_BODY_PX
            gap_before = 0
        else:
            continue
        font = ImageFont.truetype(str(font_path), size, index=font_index)
        y += gap_before
        for line in gen._wrap(draw, block.text, font, width_px - 2 * gen.SCAN_MARGIN_PX):
            draw.text((gen.SCAN_MARGIN_PX, y), line, fill=0, font=font)
            y += round(size * 1.55)
        y += 24
    jpeg = io.BytesIO()
    image.save(jpeg, format="JPEG", quality=gen.SCAN_JPEG_QUALITY, optimize=False, progressive=False, dpi=(gen.SCAN_DPI, gen.SCAN_DPI))
    pdf.drawImage(ImageReader(io.BytesIO(jpeg.getvalue())), 0, 0, width=ingest_specs.PAGE_WIDTH, height=ingest_specs.PAGE_HEIGHT)


def build_bench(bench: Any, ingest_specs: Any) -> bytes:
    from reportlab.lib import colors
    from reportlab.pdfgen import canvas
    from reportlab.platypus import Table, TableStyle

    gen = _load_generate()
    content_width = ingest_specs.PAGE_WIDTH - 2 * gen.MARGIN_X
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(ingest_specs.PAGE_WIDTH, ingest_specs.PAGE_HEIGHT), invariant=1, pageCompression=0)
    pdf.setTitle(bench.id)
    header = ("Metric", "Value")
    for page in range(1, bench.page_count + 1):
        y = ingest_specs.PAGE_HEIGHT - gen.MARGIN_TOP
        pdf.drawString(gen.MARGIN_X, y, f"Benchmark page {page}")
        y -= 24
        if page in bench.table_pages:
            rows = (header, (f"Page-{page}", "42"))
            table = Table([list(row) for row in rows], colWidths=[content_width / 2, content_width / 2])
            table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.grey), ("FONT", (0, 0), (-1, -1), "Helvetica", 9)]))
            _, height = table.wrap(content_width, ingest_specs.PAGE_HEIGHT)
            table.drawOn(pdf, gen.MARGIN_X, y - height)
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def _build_digital(spec: Any, ingest_specs: Any, font_path: Path | None = None, font_index: int = 0) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas
    from reportlab.platypus import Paragraph, Table, TableStyle

    gen = _load_generate()
    zh = spec.language == "zh"
    if zh:
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    body_font = "STSong-Light" if zh else "Helvetica"
    heading_font = "STSong-Light" if zh else "Helvetica-Bold"
    content_width = ingest_specs.PAGE_WIDTH - 2 * gen.MARGIN_X
    mid_x = ingest_specs.PAGE_WIDTH / 2
    col_width = (content_width - COLUMN_GAP) / 2
    scanned_pages = spec.facts.get("scanned_blocks", {})

    def style(name: str, font: str, size: float, leading: float, **extra: Any) -> ParagraphStyle:
        return ParagraphStyle(name=name, fontName=font, fontSize=size, leading=leading, wordWrap="CJK" if zh else None, **extra)

    body = style("body", body_font, *gen.BODY_STYLE)
    headings = {level: style(f"h{level}", heading_font, size, leading) for level, (size, leading) in gen.HEADING_STYLES.items()}
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(ingest_specs.PAGE_WIDTH, ingest_specs.PAGE_HEIGHT), invariant=1, pageCompression=0)
    pdf.setTitle(spec.id)
    page = 1
    y = ingest_specs.PAGE_HEIGHT - gen.MARGIN_TOP
    drawn_scanned: set[int] = set()

    def place(flowable: Any, gap_before: float, gap_after: float, width: float = content_width, x: float = gen.MARGIN_X) -> None:
        nonlocal y
        _, height = flowable.wrap(width, ingest_specs.PAGE_HEIGHT)
        top = y - gap_before
        if top - height < gen.MARGIN_BOTTOM:
            raise gen.LayoutError(f"{spec.id}: block does not fit on page {page}")
        flowable.drawOn(pdf, x, top - height)
        y = top - height - gap_after

    def finish_page() -> None:
        nonlocal page, y
        pdf.showPage()
        page += 1
        y = ingest_specs.PAGE_HEIGHT - gen.MARGIN_TOP

    for block in spec.blocks:
        while block.page > page:
            if page in scanned_pages:
                assert font_path is not None
                _draw_scanned_page(pdf, tuple(scanned_pages[page]), ingest_specs, gen, font_path, font_index)
            finish_page()
        if block.page in scanned_pages:
            if block.page not in drawn_scanned:
                assert font_path is not None
                _draw_scanned_page(pdf, tuple(scanned_pages[block.page]), ingest_specs, gen, font_path, font_index)
                drawn_scanned.add(block.page)
                finish_page()
            continue
        if isinstance(block, ingest_specs.Heading):
            place(Paragraph(escape(block.text), headings[block.level]), 10.0, 4.0)
        elif isinstance(block, ingest_specs.Paragraph):
            place(Paragraph(escape(block.text), body), 0.0, 6.0)
        elif isinstance(block, ingest_specs.ColumnParagraph):
            x = gen.MARGIN_X if block.column == 0 else mid_x + COLUMN_GAP / 2
            place(Paragraph(escape(block.text), body), 0.0, 6.0, width=col_width, x=x)
        elif isinstance(block, ingest_specs.Table):
            size = 8.0 if len(block.rows) > 20 else 9.5
            table = Table([list(row) for row in block.rows], colWidths=gen._column_widths(block.rows, content_width))
            table.setStyle(
                TableStyle(
                    [
                        ("FONT", (0, 0), (-1, -1), body_font, size),
                        ("FONT", (0, 0), (-1, 0), heading_font, size),
                        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e6e6e6")),
                    ]
                )
            )
            place(table, 4.0, 10.0)
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def build_pdf(spec: Any, ingest_specs: Any, gen: Any, font_path: Path | None, font_index: int) -> bytes:
    if spec.layer == "scanned":
        assert font_path is not None
        return gen.build_scanned(spec, font_path, font_index)
    return _build_digital(spec, ingest_specs, font_path, font_index)


def generate(font_path: Path | None, font_index: int = 0, out_dir: Path | None = None) -> None:
    root = HERE if out_dir is None else out_dir
    pdf_dir = root / "pdf"
    expected_dir = root / "expected"
    expected_mod = _parse_expected_mod()
    ingest = _ingest_specs()
    parse_mod = _parse_specs()
    gen = _load_generate()
    pdf_dir.mkdir(parents=True, exist_ok=True)
    expected_dir.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []
    for item in parse_mod.all_specs():
        if isinstance(item, parse_mod.BenchSpec):
            data = build_bench(item, ingest)
            spec_id = item.id
            parse_class = "bench"
            language = item.language
            page_count = item.page_count
            page_kinds = {page: "digital" for page in range(1, page_count + 1)}
            expected_spec = ingest.FixtureSpec(
                item.id,
                item.language,
                "financial_report",
                "digital",
                (),
                {
                    "page_count": item.page_count,
                    "tables": {page: (("Metric", "Value"), ("Page", "42")) for page in item.table_pages},
                    "page_kinds": page_kinds,
                },
            )
        else:
            spec_id = item.id
            parse_class = item.facts["parse_class"]
            language = item.language
            page_count = item.facts["page_count"]
            data = build_pdf(item, ingest, gen, font_path, font_index)
            expected_spec = item
        digest = sha256_hex(data)
        (pdf_dir / f"{spec_id}.pdf").write_bytes(data)
        expected = expected_mod.parser_expected(expected_spec, ingest)
        (expected_dir / f"{spec_id}.json").write_text(json.dumps(expected, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        entries.append(
            {
                "id": spec_id,
                "class": parse_class,
                "language": language,
                "sha256": digest,
                "page_count": page_count,
                "expected_path": str((PARSE_EXPECTED / f"{spec_id}.json").relative_to(HERE.parents[1])),
                "pdf_path": str((PARSE_PDF / f"{spec_id}.pdf").relative_to(HERE.parents[1])),
            }
        )
    (root / "manifest.json").write_text(json.dumps({"fixtures": sorted(entries, key=lambda row: row["id"])}, indent=2, sort_keys=True) + "\n", encoding="utf-8")