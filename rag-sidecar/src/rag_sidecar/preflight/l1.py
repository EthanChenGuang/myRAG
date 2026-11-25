"""L1 preflight: pypdfium2 on every page, pdfplumber gated (D-49, D-52)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

if TYPE_CHECKING:
    from rag_sidecar.contracts.routing import PageSignal, ParseRoutingConfig

MIN_TEXT_CHARS = 10
MULTI_COL_MIN_CHARS = 20
MULTI_COL_GAP_RATIO = 0.15
SCANNED_IMAGE_RATIO = 0.5
FIGURE_IMAGE_RATIO = 0.05
UNCERTAIN_IMAGE_LOW = 0.05
UNCERTAIN_IMAGE_HIGH = 0.5
BOTTOM_MARGIN_PT = 72.0
COLUMN_MATCH_TOL = 40.0
NUMERIC_WORD = re.compile(r"^-?\d+(?:\.\d+)?$")
MOJIBAKE_PATTERNS = (
    re.compile(r"Ã."),
    re.compile(r"Â"),
    re.compile(r"â€"),
    re.compile(r"ï»¿"),
)


class EncryptedPdf(Exception):
    """User-password PDF; permanent failure (D-12)."""


@dataclass(frozen=True)
class PageL1:
    page: int
    chars: int
    text_layer: bool
    image_area_ratio: float
    ruled_tables: int
    aligned_number_rows: int
    multi_column: bool
    has_figure: bool
    scanned: bool
    garbled_ratio: float
    uncertain: bool
    continues_to_next: bool
    signals: list[PageSignal]


@dataclass(frozen=True)
class L1Result:
    pages: list[PageL1]
    gated_pages: list[int]

    @property
    def gated_share(self) -> float:
        if not self.pages:
            return 0.0
        return len(self.gated_pages) / len(self.pages)


@dataclass
class _DraftPage:
    page: int
    chars: int
    text: str
    text_layer: bool
    image_area_ratio: float
    thin_paths: int
    aligned_number_rows: int
    multi_column: bool
    ruled_tables: int = 0
    table_bbox: tuple[float, float, float, float] | None = None
    table_tail: str | None = None
    table_head: str | None = None
    content_bottom: float | None = None
    numeric_cols: list[float] | None = None


def _is_garbled_char(ch: str) -> bool:
    code = ord(ch)
    if ch == "\ufffd":
        return True
    if 0xE000 <= code <= 0xF8FF:
        return True
    if 0xF0000 <= code <= 0xFFFFD or 0x100000 <= code <= 0x10FFFD:
        return True
    return False


def garbled_ratio(text: str) -> float:
    if not text:
        return 0.0
    garbled = 0
    for ch in text:
        if _is_garbled_char(ch):
            garbled += 1
    for pattern in MOJIBAKE_PATTERNS:
        garbled += len(pattern.findall(text))
    return min(1.0, garbled / len(text))


def _thin_path_count(page: pdfium.PdfPage, thin_pt: float) -> int:
    count = 0
    for obj in page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_PATH], max_depth=2):
        left, bottom, right, top = obj.get_bounds()
        width, height = abs(right - left), abs(top - bottom)
        if width < thin_pt or height < thin_pt:
            count += 1
    return count


def _image_area_ratio(page: pdfium.PdfPage) -> float:
    page_w, page_h = page.get_size()
    area = page_w * page_h
    if area <= 0:
        return 0.0
    covered = 0.0
    for obj in page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_IMAGE], max_depth=2):
        left, bottom, right, top = obj.get_bounds()
        covered += abs(right - left) * abs(top - bottom)
    return min(1.0, covered / area)


def _words_from_textpage(textpage: pdfium.PdfTextPage, page_height: float) -> list[tuple[str, float, float, float]]:
    """Group characters into words; return (text, x0, y0_pdfplumber, len)."""
    total = textpage.count_chars()
    if total <= 0:
        return []
    words: list[tuple[str, float, float, float]] = []
    parts: list[str] = []
    x0 = x1 = y0 = y1 = 0.0
    last_x = None
    for index in range(total):
        ch = textpage.get_text_range(index, 1)
        if ch.isspace():
            if parts:
                words.append(("".join(parts), x0, page_height - y1, float(len(parts))))
                parts = []
                last_x = None
            continue
        bx0, by0, bx1, by1 = textpage.get_charbox(index)
        if not parts:
            x0, y0, x1, y1 = bx0, by0, bx1, by1
        else:
            if last_x is not None and bx0 - last_x > bx1 - bx0:
                words.append(("".join(parts), x0, page_height - y1, float(len(parts))))
                parts = []
                x0, y0, x1, y1 = bx0, by0, bx1, by1
            else:
                x1, y1 = max(x1, bx1), max(y1, by1)
        parts.append(ch)
        last_x = bx1
    if parts:
        words.append(("".join(parts), x0, page_height - y1, float(len(parts))))
    return words


def _aligned_number_rows(words: list[tuple[str, float, float, float]], y_tol: float = 4.0) -> int:
    rows: dict[int, list[float]] = {}
    for text, x0, y0, _length in words:
        if not NUMERIC_WORD.match(text):
            continue
        key = round(y0 / y_tol)
        rows.setdefault(key, []).append(x0)
    count = 0
    for xs in rows.values():
        if len(xs) >= 2 and max(xs) - min(xs) > 40:
            count += 1
    return count


def _numeric_column_positions(words: list[tuple[str, float, float, float]]) -> list[float]:
    cols: list[float] = []
    for text, x0, _y0, _length in words:
        if NUMERIC_WORD.match(text):
            cols.append(x0)
    return sorted(cols)


def _multi_column(words: list[tuple[str, float, float, float]], page_width: float) -> bool:
    if page_width <= 0:
        return False
    half = page_width / 2
    rows: dict[int, list[tuple[str, float]]] = {}
    for text, x0, y0, _length in words:
        key = round(y0 / 5)
        rows.setdefault(key, []).append((text, x0))
    left_block = False
    right_block = False
    for items in rows.values():
        if sum(len(t) for t, _ in items) < MULTI_COL_MIN_CHARS:
            continue
        if all(x < half for _t, x in items):
            left_block = True
        if all(x >= half for _t, x in items):
            right_block = True
    return left_block and right_block


def _columns_match(a: list[float], b: list[float], tol: float = COLUMN_MATCH_TOL) -> bool:
    if not a or not b:
        return False
    matches = 0
    for x in a:
        if any(abs(x - y) <= tol for y in b):
            matches += 1
    return matches >= 2


def _continues_to_next(
    current: _DraftPage,
    nxt: _DraftPage,
    *,
    current_table_tail: str | None,
    next_table_head: str | None,
    content_bottom: float | None,
) -> bool:
    if current.ruled_tables < 1 or nxt.ruled_tables < 1:
        return False
    if not current_table_tail or not next_table_head:
        return False
    if current_table_tail.strip().lower() == next_table_head.strip().lower():
        if current.table_bbox is None:
            return False
        _x0, _y0, _x1, y1 = current.table_bbox
        if content_bottom is not None and y1 <= content_bottom + 8:
            return True
    return False


def _page_is_uncertain(
    draft: _DraftPage,
    *,
    scanned: bool,
    has_table_signal: bool,
) -> bool:
    if scanned:
        return True
    if draft.multi_column and draft.ruled_tables == 0:
        return True
    if draft.ruled_tables >= 1 and draft.aligned_number_rows >= 1:
        return True
    if draft.aligned_number_rows >= 1 and draft.thin_paths < 1 and draft.ruled_tables < 1:
        return True
    if UNCERTAIN_IMAGE_LOW < draft.image_area_ratio < UNCERTAIN_IMAGE_HIGH and draft.chars >= MIN_TEXT_CHARS:
        return True
    if has_table_signal and draft.ruled_tables == 0 and draft.aligned_number_rows >= 2:
        return True
    return False


def _derive_signals(
    draft: _DraftPage,
    *,
    scanned: bool,
    has_figure: bool,
    uncertain: bool,
    continues: bool,
    garbled: float,
    cfg: ParseRoutingConfig,
) -> list[PageSignal]:
    from rag_sidecar.contracts.routing import PageSignal as _PageSignal

    signals: list[_PageSignal] = []
    has_tables = draft.ruled_tables > 0 or draft.aligned_number_rows >= 2
    if has_tables:
        signals.append("tables")
    if draft.multi_column:
        signals.append("multi_col")
    if has_figure:
        signals.append("has_figure")
    if scanned:
        signals.append("scanned")
    if garbled > cfg.l1.garbled_ratio:
        signals.append("garbled")
    if continues:
        signals.append("table_continues")
    return signals


def l1_signals(path: Path | str, cfg: ParseRoutingConfig) -> L1Result:
    target = Path(path)
    try:
        document = pdfium.PdfDocument(str(target))
    except pdfium.PdfiumError as error:
        message = str(error).lower()
        if "password" in message:
            raise EncryptedPdf("encrypted PDF") from error
        raise

    drafts: list[_DraftPage] = []
    try:
        for index in range(len(document)):
            page = document[index]
            try:
                width, _height = page.get_size()
                textpage = page.get_textpage()
                try:
                    text = textpage.get_text_range()
                    chars = textpage.count_chars()
                    words = _words_from_textpage(textpage, _height)
                finally:
                    textpage.close()
                thin_paths = _thin_path_count(page, cfg.l1.thin_path_pt)
                aligned_rows = _aligned_number_rows(words)
                drafts.append(
                    _DraftPage(
                        page=index + 1,
                        chars=chars,
                        text=text,
                        text_layer=len(text.strip()) >= MIN_TEXT_CHARS,
                        image_area_ratio=_image_area_ratio(page),
                        thin_paths=thin_paths,
                        aligned_number_rows=aligned_rows,
                        multi_column=_multi_column(words, width),
                        numeric_cols=_numeric_column_positions(words),
                    )
                )
            finally:
                page.close()
    finally:
        document.close()

    min_ruling = cfg.l1.min_ruling_paths
    gated = [
        d.page
        for d in drafts
        if d.thin_paths >= min_ruling or d.aligned_number_rows >= 1
    ]

    if gated:
        import pdfplumber

        with pdfplumber.open(str(target)) as pdf:
            for page_no in gated:
                draft = drafts[page_no - 1]
                pl_page = pdf.pages[page_no - 1]
                tables = pl_page.find_tables()
                draft.ruled_tables = len(tables)
                if tables:
                    draft.table_bbox = tables[0].bbox
                    extracted = tables[0].extract()
                    if extracted:
                        last_row = extracted[-1]
                        first_row = extracted[0]
                        if last_row and last_row[0]:
                            draft.table_tail = str(last_row[0])
                        if first_row and first_row[0]:
                            draft.table_head = str(first_row[0])
                plum_words = pl_page.extract_words() or []
                if plum_words:
                    draft.content_bottom = max(w["bottom"] for w in plum_words)
                if plum_words:
                    pl_rows = _aligned_number_rows(
                        [(w["text"], w["x0"], w["top"], float(len(w.get("text", "")))) for w in plum_words]
                    )
                    draft.aligned_number_rows = max(draft.aligned_number_rows, pl_rows)
                    draft.numeric_cols = _numeric_column_positions(
                        [(w["text"], w["x0"], w["top"], float(len(w.get("text", "")))) for w in plum_words]
                    ) or draft.numeric_cols
            for draft in drafts:
                if draft.ruled_tables > 0 or draft.aligned_number_rows >= 2:
                    draft.multi_column = False

    pages: list[PageL1] = []
    for index, draft in enumerate(drafts):
        garbled = garbled_ratio(draft.text)
        scanned = draft.chars < cfg.l1.scanned_max_chars and draft.image_area_ratio > SCANNED_IMAGE_RATIO
        has_figure = not scanned and draft.image_area_ratio > FIGURE_IMAGE_RATIO
        has_table_signal = draft.ruled_tables > 0 or draft.aligned_number_rows >= 2
        uncertain = _page_is_uncertain(draft, scanned=scanned, has_table_signal=has_table_signal)
        continues = False
        if index + 1 < len(drafts):
            nxt = drafts[index + 1]
            continues = _continues_to_next(
                draft,
                nxt,
                current_table_tail=draft.table_tail,
                next_table_head=nxt.table_head,
                content_bottom=draft.content_bottom,
            )
        signals = _derive_signals(
            draft,
            scanned=scanned,
            has_figure=has_figure,
            uncertain=uncertain,
            continues=continues,
            garbled=garbled,
            cfg=cfg,
        )
        pages.append(
            PageL1(
                page=draft.page,
                chars=draft.chars,
                text_layer=draft.text_layer,
                image_area_ratio=draft.image_area_ratio,
                ruled_tables=draft.ruled_tables,
                aligned_number_rows=draft.aligned_number_rows,
                multi_column=draft.multi_column,
                has_figure=has_figure,
                scanned=scanned,
                garbled_ratio=garbled,
                uncertain=uncertain,
                continues_to_next=continues,
                signals=signals,
            )
        )

    return L1Result(pages=pages, gated_pages=gated)