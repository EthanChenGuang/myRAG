"""PDF hidden-text checker over the page objects of the original (D-33, research F-6, Pitfall 14).

Works on pdfium's page objects in content (z) order, independently of the parser that produced the text.
Never fetches, resolves or opens a link target; reads only the bytes it is given. Optional imports
(pypdfium2, pdfplumber from the preflight extra) happen inside the call.
"""

from __future__ import annotations

import ctypes
import math
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from rag_sidecar.security.hidden_text import (
    CheckerUnavailable,
    CheckOutcome,
    EncryptedDocument,
    FoundSpan,
    UnreadableDocument,
)

if TYPE_CHECKING:
    from rag_sidecar.contracts.ingest_security import HiddenTextRules, HiddenTextSpanReason, PdfHiddenTextRules

Box = tuple[float, float, float, float]
Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
PAGE_WHITE = (1.0, 1.0, 1.0)
INVISIBLE_MODES = frozenset({3, 7})
STROKE_ONLY_MODES = frozenset({1, 5})
MAX_FORM_DEPTH = 8
FPDF_ERR_PASSWORD = 4

# pdfium is not thread-safe; one check at a time in this process.
_PDFIUM_LOCK = threading.Lock()


@dataclass(frozen=True)
class _Obj:
    order: int
    kind: str  # text | path | image | other
    box: Box
    fill: tuple[float, float, float, float]  # rgba, 0..1
    stroke: tuple[float, float, float, float]
    text: str = ""
    size: float = 0.0
    mode: int = 0
    filled: bool = False
    opaque: bool = True

    @property
    def area(self) -> float:
        return _area(self.box)

    @property
    def center(self) -> tuple[float, float]:
        return ((self.box[0] + self.box[2]) / 2, (self.box[1] + self.box[3]) / 2)


def _area(box: Box) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def _intersection(a: Box, b: Box) -> float:
    return _area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def _contains_point(box: Box, point: tuple[float, float]) -> bool:
    return box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]


def _coverage(cover: Box, target: _Obj) -> float:
    """Share of `target` that `cover` hides; a zero-area target counts by its centre point."""
    if target.area <= 0:
        return 1.0 if _contains_point(cover, target.center) else 0.0
    return _intersection(cover, target.box) / target.area


def _compose(inner: Matrix, outer: Matrix) -> Matrix:
    a1, b1, c1, d1, e1, f1 = inner
    a2, b2, c2, d2, e2, f2 = outer
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def _transform_box(box: Box, matrix: Matrix) -> Box:
    if matrix == IDENTITY:
        return box
    a, b, c, d, e, f = matrix
    xs: list[float] = []
    ys: list[float] = []
    for x, y in ((box[0], box[1]), (box[0], box[3]), (box[2], box[1]), (box[2], box[3])):
        xs.append(a * x + c * y + e)
        ys.append(b * x + d * y + f)
    return (min(xs), min(ys), max(xs), max(ys))


def _scale(matrix: Matrix) -> float:
    a, b, c, d, _, _ = matrix
    return math.sqrt(abs(a * d - b * c))


def _color_distance(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b))) / math.sqrt(3.0)


class _Reader:
    def __init__(self, pdfium_c: Any, textpage: Any) -> None:
        self.c = pdfium_c
        self.textpage = textpage
        self.order = 0

    def _matrix(self, obj: Any) -> Matrix:
        matrix = self.c.FS_MATRIX()
        if not self.c.FPDFPageObj_GetMatrix(obj, matrix):
            return IDENTITY
        return (matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f)

    def _box(self, obj: Any) -> Box | None:
        left, bottom, right, top = (ctypes.c_float() for _ in range(4))
        if not self.c.FPDFPageObj_GetBounds(obj, left, bottom, right, top):
            return None
        return (left.value, bottom.value, right.value, top.value)

    def _rgba(self, getter: Any, obj: Any) -> tuple[float, float, float, float]:
        r, g, b, a = (ctypes.c_uint() for _ in range(4))
        if not getter(obj, r, g, b, a):
            return (0.0, 0.0, 0.0, 1.0)
        return (r.value / 255.0, g.value / 255.0, b.value / 255.0, a.value / 255.0)

    def _text(self, obj: Any) -> str:
        length = self.c.FPDFTextObj_GetText(obj, self.textpage, None, 0)
        if length <= 0:
            return ""
        buffer = ctypes.create_string_buffer(length * 2)
        self.c.FPDFTextObj_GetText(obj, self.textpage, ctypes.cast(buffer, ctypes.POINTER(self.c.FPDF_WCHAR)), length)
        return buffer.raw.decode("utf-16-le", errors="replace").split("\x00", 1)[0]

    def _filled_rect_like(self, obj: Any) -> bool:
        fill_mode, stroke = ctypes.c_int(), ctypes.c_int()
        if not self.c.FPDFPath_GetDrawMode(obj, fill_mode, stroke):
            return False
        return fill_mode.value != 0

    def read(self, container: Any, count: int, get: Any, outer: Matrix, depth: int, out: list[_Obj]) -> None:
        c = self.c
        for index in range(count):
            obj = get(container, index)
            if not obj:
                continue
            kind = c.FPDFPageObj_GetType(obj)
            if kind == c.FPDF_PAGEOBJ_FORM:
                if depth < MAX_FORM_DEPTH:
                    nested = c.FPDFFormObj_CountObjects(obj)
                    self.read(obj, nested, c.FPDFFormObj_GetObject, _compose(self._matrix(obj), outer), depth + 1, out)
                continue
            raw_box = self._box(obj)
            if raw_box is None:
                continue
            # Objects nested in a form report bounds in form space; the page objects already in page space.
            box = _transform_box(raw_box, outer) if depth > 0 else raw_box
            self.order += 1
            fill = self._rgba(c.FPDFPageObj_GetFillColor, obj)
            stroke = self._rgba(c.FPDFPageObj_GetStrokeColor, obj)
            if kind == c.FPDF_PAGEOBJ_TEXT:
                size = ctypes.c_float()
                if not c.FPDFTextObj_GetFontSize(obj, size):
                    size.value = 0.0
                scale = _scale(self._matrix(obj)) * (_scale(outer) if depth > 0 else 1.0)
                out.append(
                    _Obj(
                        order=self.order,
                        kind="text",
                        box=box,
                        fill=fill,
                        stroke=stroke,
                        text=self._text(obj),
                        size=abs(size.value) * scale,
                        mode=int(c.FPDFTextObj_GetTextRenderMode(obj)),
                    )
                )
            elif kind == c.FPDF_PAGEOBJ_PATH:
                out.append(
                    _Obj(
                        order=self.order,
                        kind="path",
                        box=box,
                        fill=fill,
                        stroke=stroke,
                        filled=self._filled_rect_like(obj),
                        opaque=fill[3] >= 1.0 and not c.FPDFPageObj_HasTransparency(obj),
                    )
                )
            elif kind == c.FPDF_PAGEOBJ_IMAGE:
                out.append(
                    _Obj(
                        order=self.order,
                        kind="image",
                        box=box,
                        fill=fill,
                        stroke=stroke,
                        opaque=not c.FPDFPageObj_HasTransparency(obj),
                    )
                )
            else:
                out.append(_Obj(order=self.order, kind="other", box=box, fill=fill, stroke=stroke, opaque=False))


def _background(text: _Obj, objects: list[_Obj]) -> tuple[float, float, float] | None:
    """Colour under the text: the topmost filled path drawn before it under its centre, else page white.

    An image under the centre makes the background unknown (None), so the colour rule does not apply.
    """
    for obj in reversed(objects[: objects.index(text)]):
        if obj.kind == "path" and obj.filled and _contains_point(obj.box, text.center):
            return obj.fill[:3]
        if obj.kind == "image" and _contains_point(obj.box, text.center):
            return None
    return PAGE_WHITE


def _over_image(text: _Obj, objects: list[_Obj], rules: PdfHiddenTextRules) -> bool:
    """Invisible text drawn over an image is an OCR text layer, not hidden text."""
    return any(
        obj.kind == "image" and _coverage(obj.box, text) >= rules.covered_overlap_min
        for obj in objects[: objects.index(text)]
    )


def _outside(text: _Obj, page_box: Box, margin: float) -> bool:
    grown = (page_box[0] - margin, page_box[1] - margin, page_box[2] + margin, page_box[3] + margin)
    return not _contains_point(grown, text.center)


def _too_small(text: _Obj, rules: PdfHiddenTextRules, median: float) -> bool:
    if text.size >= rules.min_font_size_pt:
        return False
    return median <= 0 or text.size < rules.min_font_size_ratio * median


def _covered(text: _Obj, objects: list[_Obj], rules: PdfHiddenTextRules) -> bool:
    """An opaque filled path or image drawn after the text hides enough of it."""
    for obj in objects[objects.index(text) + 1 :]:
        if not obj.opaque:
            continue
        if (obj.kind == "path" and obj.filled) or obj.kind == "image":
            if _coverage(obj.box, text) >= rules.covered_overlap_min:
                return True
    return False


def _hidden_reason(text: _Obj, objects: list[_Obj], rules: PdfHiddenTextRules, page_box: Box, median: float) -> HiddenTextSpanReason | None:
    """First matching rule wins, in a fixed order, so every span has one reason."""
    if text.mode in INVISIBLE_MODES:
        return None if _over_image(text, objects, rules) else "invisible_render_mode"
    if _outside(text, page_box, rules.outside_page_margin_pt):
        return "outside_page"
    if _too_small(text, rules, median):
        return "font_too_small"
    if _covered(text, objects, rules):
        return "covered_by_object"
    if text.mode in STROKE_ONLY_MODES:
        color, alpha = text.stroke[:3], text.stroke[3]
    else:
        color, alpha = text.fill[:3], text.fill[3]
    if alpha <= rules.color_distance_max:
        return "color_near_background"
    background = _background(text, objects)
    if background is not None and _color_distance(color, background) <= rules.color_distance_max:
        return "color_near_background"
    return None


def _weighted_median(values: list[tuple[float, int]]) -> float:
    ordered = sorted((value, weight) for value, weight in values if weight > 0)
    total = sum(weight for _, weight in ordered)
    if total == 0:
        return 0.0
    running = 0
    for value, weight in ordered:
        running += weight
        if running * 2 >= total:
            return value
    return ordered[-1][0]


def _join(left: str, right: str) -> str:
    if not left or not right:
        return left + right
    if left[-1].isspace() or right[0].isspace():
        return left + right
    if left[-1].isascii() and right[0].isascii():
        return f"{left} {right}"
    return left + right


def _merge(hits: list[tuple[_Obj, HiddenTextSpanReason]], page_number: int, texts: list[_Obj]) -> list[FoundSpan]:
    """Join hidden text objects that follow each other in content order with the same reason."""
    position = {obj.order: index for index, obj in enumerate(texts)}
    spans: list[FoundSpan] = []
    current: list[_Obj] = []
    reason: HiddenTextSpanReason | None = None

    def flush() -> None:
        if not current or reason is None:
            return
        joined = ""
        for obj in current:
            joined = _join(joined, obj.text.strip())
        box = (
            min(obj.box[0] for obj in current),
            min(obj.box[1] for obj in current),
            max(obj.box[2] for obj in current),
            max(obj.box[3] for obj in current),
        )
        spans.append(FoundSpan(page=page_number, text=joined.strip(), reason=reason, bbox=box, order=current[0].order))

    for obj, why in hits:
        adjacent = bool(current) and position[obj.order] == position[current[-1].order] + 1
        if current and (why != reason or not adjacent):
            flush()
            current = []
        current.append(obj)
        reason = why
    flush()
    return spans


def _significant(text: str) -> int:
    return sum(1 for char in text if not char.isspace())


def _check_page(objects: list[_Obj], page_number: int, page_box: Box, rules: PdfHiddenTextRules) -> list[FoundSpan]:
    texts = [obj for obj in objects if obj.kind == "text" and obj.text.strip()]
    median = _weighted_median([(obj.size, _significant(obj.text)) for obj in texts if obj.mode not in INVISIBLE_MODES])
    hits: list[tuple[_Obj, HiddenTextSpanReason]] = []
    for text in texts:
        reason = _hidden_reason(text, objects, rules, page_box, median)
        if reason is not None:
            hits.append((text, reason))
    return [span for span in _merge(hits, page_number, texts) if _significant(span.text) >= rules.min_span_chars]


def _link_targets(pdfium_c: Any, document: Any, page: Any) -> list[str]:
    targets: list[str] = []
    position = ctypes.c_int(0)
    link = pdfium_c.FPDF_LINK()
    while pdfium_c.FPDFLink_Enumerate(page, position, link):
        action = pdfium_c.FPDFLink_GetAction(link)
        if not action or pdfium_c.FPDFAction_GetType(action) != pdfium_c.PDFACTION_URI:
            continue
        length = pdfium_c.FPDFAction_GetURIPath(document, action, None, 0)
        if length <= 1:
            continue
        buffer = ctypes.create_string_buffer(length)
        pdfium_c.FPDFAction_GetURIPath(document, action, buffer, length)
        target = buffer.raw.split(b"\x00", 1)[0].decode("latin-1").strip()
        if target:
            targets.append(target)
    return targets


def _zero_pages(data: bytes) -> bool:
    import io

    import pdfplumber

    try:
        with pdfplumber.open(io.BytesIO(data)) as document:
            return len(document.pages) == 0
    except Exception:
        return False


def check_pdf_hidden_text(data: bytes, rules: HiddenTextRules) -> CheckOutcome:
    try:
        import pdfplumber  # noqa: F401
        import pypdfium2 as pdfium
        import pypdfium2.raw as pdfium_c
    except ImportError as missing:
        raise CheckerUnavailable("preflight extra not installed") from missing

    with _PDFIUM_LOCK:
        try:
            document = pdfium.PdfDocument(data)
        except pdfium.PdfiumError as error:
            # pdfium sets no error for an empty page tree, so its last-error code can be stale: count pages separately.
            if _zero_pages(data):
                return CheckOutcome(checked=True, spans=[], link_targets=[])
            if getattr(error, "err_code", None) == FPDF_ERR_PASSWORD:
                raise EncryptedDocument("password required") from error
            raise UnreadableDocument("pdf could not be opened") from error
        spans: list[FoundSpan] = []
        targets: list[str] = []
        try:
            for index in range(len(document)):
                page = document[index]
                textpage = page.get_textpage()
                try:
                    objects: list[_Obj] = []
                    reader = _Reader(pdfium_c, textpage.raw)
                    reader.read(page.raw, pdfium_c.FPDFPage_CountObjects(page.raw), pdfium_c.FPDFPage_GetObject, IDENTITY, 0, objects)
                    page_box = _visible_box(page)
                    spans.extend(_check_page(objects, index + 1, page_box, rules.pdf))
                    targets.extend(_link_targets(pdfium_c, document.raw, page.raw))
                finally:
                    textpage.close()
                    page.close()
        finally:
            document.close()
    return CheckOutcome(checked=True, spans=spans, link_targets=targets)


def _visible_box(page: Any) -> Box:
    media = tuple(float(value) for value in page.get_mediabox())
    crop = tuple(float(value) for value in page.get_cropbox())
    return (max(media[0], crop[0]), max(media[1], crop[1]), min(media[2], crop[2]), min(media[3], crop[3]))
