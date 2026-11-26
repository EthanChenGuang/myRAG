"""Word (.docx) hidden-text checker (D-33 Word part, research F-6).

The package is untrusted input. It is opened with the standard zip reader under a member-count cap and a cap on
every declared uncompressed size, checked before any member is read; each XML part is parsed with defusedxml
(no DTD, no entity, no external reference), and only parts reached through internal relationships are read.
Nothing is fetched.

Run properties are resolved the way Word renders them: document defaults, then the table style, then the
paragraph style and its basedOn chain, then the character style chain, then the run's own properties; the last
one that sets a property wins.
"""

from __future__ import annotations

import io
import math
import posixpath
import zipfile
from dataclasses import dataclass, field, replace
from xml.etree.ElementTree import Element, ParseError

from rag_sidecar.contracts.ingest_security import HiddenTextRules, HiddenTextSpanReason
from rag_sidecar.security.hidden_text import (
    CheckerUnavailable,
    CheckOutcome,
    EncryptedDocument,
    FoundSpan,
    UnreadableDocument,
    UnsafePackage,
)

MAX_MEMBERS = 2_000
MAX_PART_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
MAX_DEPTH = 256
MAX_STYLE_CHAIN = 64

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
STRICT_REL_BASE = "http://purl.oclc.org/ooxml/officeDocument/relationships/"
MAIN_DOCUMENT = "officeDocument"
STORY_PARTS = ("header", "footer", "footnotes", "endnotes")
OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
OFF_VALUES = frozenset({"0", "false", "off", "none"})


def _parse(data: bytes) -> Element:
    try:
        from defusedxml import DefusedXmlException
        from defusedxml.ElementTree import fromstring
    except ImportError as exc:
        raise CheckerUnavailable("defusedxml") from exc
    try:
        return fromstring(data, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    except DefusedXmlException as exc:
        raise UnsafePackage(type(exc).__name__) from exc
    except ParseError as exc:
        raise UnreadableDocument("malformed XML part") from exc


class _Package:
    def __init__(self, data: bytes) -> None:
        if data.startswith(OLE_MAGIC):
            raise EncryptedDocument("OLE container (password-protected Word file)")
        try:
            self._zip = zipfile.ZipFile(io.BytesIO(data))
            infos = self._zip.infolist()
        except (zipfile.BadZipFile, zipfile.LargeZipFile, ValueError, OSError) as exc:
            raise UnreadableDocument("not a zip package") from exc
        if len(infos) > MAX_MEMBERS:
            raise UnsafePackage("too many members")
        total = 0
        for info in infos:
            if info.file_size > MAX_PART_BYTES:
                raise UnsafePackage("member too large")
            total += info.file_size
        if total > MAX_TOTAL_BYTES:
            raise UnsafePackage("package too large")
        if any(info.flag_bits & 0x1 for info in infos):
            raise EncryptedDocument("encrypted zip members")
        self._names = {info.filename for info in infos}

    def has(self, name: str) -> bool:
        return name in self._names

    def read_xml(self, name: str) -> Element | None:
        if name not in self._names:
            return None
        try:
            with self._zip.open(name) as handle:
                data = handle.read(MAX_PART_BYTES + 1)
        except (zipfile.BadZipFile, NotImplementedError, RuntimeError, OSError, EOFError) as exc:
            raise UnreadableDocument("unreadable zip member") from exc
        if len(data) > MAX_PART_BYTES:
            raise UnsafePackage("member too large")
        return _parse(data)

    def relationships(self, part: str) -> list[tuple[str, str]]:
        """Internal relationships of a part as (type suffix, target part name); external targets are skipped."""
        folder, base = posixpath.split(part)
        root = self.read_xml(posixpath.join(folder, "_rels", f"{base}.rels") if part else "_rels/.rels")
        if root is None:
            return []
        out: list[tuple[str, str]] = []
        for rel in root.iter(f"{REL}Relationship"):
            if (rel.get("TargetMode") or "").lower() == "external":
                continue
            kind = rel.get("Type") or ""
            for prefix in (REL_BASE, STRICT_REL_BASE):
                if kind.startswith(prefix):
                    kind = kind[len(prefix) :]
                    break
            target = rel.get("Target") or ""
            if "://" in target or not target:
                continue
            resolved = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(folder, target))
            if resolved.startswith("../") or resolved == "..":
                continue
            out.append((kind, resolved))
        return out


def _on(element: Element | None) -> bool | None:
    """A toggle property: absent -> None, present -> on unless w:val says off."""
    if element is None:
        return None
    value = element.get(f"{W}val")
    return value is None or value.strip().lower() not in OFF_VALUES


RGB = tuple[float, float, float]
WHITE: RGB = (1.0, 1.0, 1.0)
DEFAULT_SIZE_HALF_POINTS = 20
HIGHLIGHT_HEX = {
    "black": "000000", "blue": "0000FF", "cyan": "00FFFF", "green": "00FF00", "magenta": "FF00FF",
    "red": "FF0000", "yellow": "FFFF00", "white": "FFFFFF", "darkBlue": "000080", "darkCyan": "008080",
    "darkGreen": "008000", "darkMagenta": "800080", "darkRed": "800000", "darkYellow": "808000",
    "darkGray": "808080", "lightGray": "C0C0C0",
}


def _hex(value: str | None) -> RGB | None:
    if not value or len(value) != 6:
        return None
    try:
        number = int(value, 16)
    except ValueError:
        return None
    return ((number >> 16 & 0xFF) / 255.0, (number >> 8 & 0xFF) / 255.0, (number & 0xFF) / 255.0)


def _shading(element: Element | None) -> RGB | None:
    """The colour a w:shd paints: the fill for clear and pattern shading, the pattern colour when solid."""
    if element is None:
        return None
    pattern = (element.get(f"{W}val") or "clear").lower()
    if pattern == "nil":
        return None
    if pattern == "solid":
        return _hex(element.get(f"{W}color"))
    return _hex(element.get(f"{W}fill"))


def _distance(a: RGB, b: RGB) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b, strict=True))) / math.sqrt(3.0)


@dataclass(frozen=True)
class _Props:
    vanish: bool | None = None
    color: RGB | None = None
    size: int | None = None
    background: RGB | None = None

    def merged(self, rpr: Element | None) -> _Props:
        if rpr is None:
            return self
        vanish = _on(rpr.find(f"{W}vanish"))
        color_el = rpr.find(f"{W}color")
        color = self.color
        if color_el is not None:
            color = _hex(color_el.get(f"{W}val"))
        size = self.size
        size_raw = _val(rpr, "sz")
        if size_raw is not None:
            try:
                size = int(float(size_raw))
            except ValueError:
                pass
        background = self.background
        shd = rpr.find(f"{W}shd")
        if shd is not None:
            background = _shading(shd)
        highlight = _val(rpr, "highlight")
        if highlight is not None:
            background = _hex(HIGHLIGHT_HEX.get(highlight)) or background
        return _Props(
            vanish=self.vanish if vanish is None else vanish,
            color=color,
            size=size,
            background=background,
        )


@dataclass
class _Style:
    based_on: str | None
    rpr: Element | None
    ppr: Element | None
    element: Element


@dataclass
class _Styles:
    defaults: _Props = field(default_factory=_Props)
    styles: dict[str, _Style] = field(default_factory=dict)
    default_paragraph: str | None = None

    @classmethod
    def load(cls, root: Element | None) -> _Styles:
        if root is None:
            return cls()
        defaults = _Props().merged(root.find(f"{W}docDefaults/{W}rPrDefault/{W}rPr"))
        styles: dict[str, _Style] = {}
        default_paragraph = None
        for style in root.findall(f"{W}style"):
            style_id = style.get(f"{W}styleId")
            if not style_id:
                continue
            styles[style_id] = _Style(
                based_on=_val(style, "basedOn"),
                rpr=style.find(f"{W}rPr"),
                ppr=style.find(f"{W}pPr"),
                element=style,
            )
            is_default = (style.get(f"{W}default") or "").lower() in {"1", "true", "on"}
            if style.get(f"{W}type") == "paragraph" and is_default and default_paragraph is None:
                default_paragraph = style_id
        return cls(defaults=defaults, styles=styles, default_paragraph=default_paragraph)

    def chain(self, style_id: str | None) -> list[_Style]:
        """A style and its basedOn ancestors, base first; cycles and over-long chains stop."""
        out: list[_Style] = []
        seen: set[str] = set()
        current = style_id
        while current and current not in seen and len(seen) < MAX_STYLE_CHAIN:
            seen.add(current)
            style = self.styles.get(current)
            if style is None:
                break
            out.append(style)
            current = style.based_on
        return list(reversed(out))

    def apply(self, base: _Props, style_id: str | None) -> _Props:
        props = base
        for style in self.chain(style_id):
            props = props.merged(style.rpr)
        return props

    def paragraph_shading(self, style_id: str | None) -> RGB | None:
        shading = None
        for style in self.chain(style_id):
            if style.ppr is not None and style.ppr.find(f"{W}shd") is not None:
                shading = _shading(style.ppr.find(f"{W}shd"))
        return shading

    def table_fills(self, style_id: str | None) -> list[RGB]:
        """Every fill a table style chain can paint (whole table, cells or conditional rows and columns)."""
        fills: list[RGB] = []
        for style in self.chain(style_id):
            for shd in style.element.iter(f"{W}shd"):
                fill = _shading(shd)
                if fill is not None and fill not in fills:
                    fills.append(fill)
        return fills


def _val(parent: Element | None, tag: str) -> str | None:
    if parent is None:
        return None
    child = parent.find(f"{W}{tag}")
    return child.get(f"{W}val") if child is not None else None


def _run_text(run: Element) -> str:
    parts: list[str] = []
    for child in run:
        if child.tag in (f"{W}t", f"{W}delText"):
            parts.append(child.text or "")
        elif child.tag == f"{W}tab":
            parts.append("\t")
        elif child.tag in (f"{W}br", f"{W}cr"):
            parts.append("\n")
        elif child.tag == f"{W}noBreakHyphen":
            parts.append("-")
    return "".join(parts)


@dataclass
class _Context:
    styles: _Styles
    rules: HiddenTextRules
    spans: list[FoundSpan]
    order: int = 0
    pending_reason: HiddenTextSpanReason | None = None
    pending_text: list[str] = field(default_factory=list)

    def hit(self, reason: HiddenTextSpanReason | None, text: str) -> None:
        if reason != self.pending_reason:
            self.flush()
            self.pending_reason = reason
        if reason is not None:
            self.pending_text.append(text)

    def flush(self) -> None:
        if self.pending_reason is not None:
            self.add(self.pending_reason, "".join(self.pending_text))
        self.pending_reason = None
        self.pending_text = []

    def add(self, reason: HiddenTextSpanReason, text: str) -> None:
        cleaned = " ".join(text.split())
        if sum(1 for char in cleaned if not char.isspace()) < self.rules.docx.min_span_chars:
            return
        self.spans.append(FoundSpan(page=None, text=cleaned, reason=reason, bbox=None, order=self.order))
        self.order += 1


@dataclass(frozen=True)
class _Where:
    base: _Props
    # The colours that can lie under the text: one when it is known, several when a table style may paint any of them.
    backgrounds: tuple[RGB, ...]
    paragraph: _Props | None = None
    deleted: bool = False


def _run_reason(run: Element, where: _Where, ctx: _Context) -> HiddenTextSpanReason | None:
    if where.deleted:
        return "tracked_deletion"
    rpr = run.find(f"{W}rPr")
    paragraph = where.paragraph if where.paragraph is not None else where.base
    props = ctx.styles.apply(paragraph, _val(rpr, "rStyle")).merged(rpr)
    if props.vanish:
        return "vanished_run"
    size = props.size if props.size is not None else DEFAULT_SIZE_HALF_POINTS
    if size < ctx.rules.docx.min_font_size_half_points:
        return "font_too_small"
    if props.color is not None:
        backgrounds = (props.background,) if props.background is not None else where.backgrounds
        limit = ctx.rules.docx.color_distance_max
        if backgrounds and all(_distance(props.color, background) <= limit for background in backgrounds):
            return "color_near_background"
    return None


def _table(element: Element, where: _Where, ctx: _Context) -> _Where:
    tblpr = element.find(f"{W}tblPr")
    style_id = _val(tblpr, "tblStyle")
    base = ctx.styles.apply(ctx.styles.defaults, style_id)
    own = _shading(tblpr.find(f"{W}shd")) if tblpr is not None else None
    if own is not None:
        backgrounds: tuple[RGB, ...] = (own,)
    else:
        backgrounds = tuple(dict.fromkeys((*where.backgrounds, *ctx.styles.table_fills(style_id))))
    return replace(where, base=base, backgrounds=backgrounds, paragraph=None)


def _cell(element: Element, where: _Where) -> _Where:
    fill = _shading(element.find(f"{W}tcPr/{W}shd"))
    return replace(where, backgrounds=(fill,)) if fill is not None else where


def _paragraph(element: Element, where: _Where, ctx: _Context) -> _Where:
    ppr = element.find(f"{W}pPr")
    style_id = _val(ppr, "pStyle") or ctx.styles.default_paragraph
    paragraph = ctx.styles.apply(where.base, style_id)
    shading = _shading(ppr.find(f"{W}shd")) if ppr is not None and ppr.find(f"{W}shd") is not None else None
    if shading is None:
        shading = ctx.styles.paragraph_shading(style_id)
    backgrounds = (shading,) if shading is not None else where.backgrounds
    return replace(where, paragraph=paragraph, backgrounds=backgrounds)


def _walk(element: Element, where: _Where, ctx: _Context, depth: int) -> None:
    if depth > MAX_DEPTH:
        raise UnsafePackage("nesting too deep")
    for child in element:
        tag = child.tag
        if tag == f"{MC}AlternateContent":
            choice = next(iter(child), None)
            if choice is not None:
                _walk(choice, where, ctx, depth + 1)
        elif tag == f"{W}p":
            ctx.flush()
            _walk(child, _paragraph(child, where, ctx), ctx, depth + 1)
            ctx.flush()
        elif tag == f"{W}tbl":
            ctx.flush()
            _walk(child, _table(child, where, ctx), ctx, depth + 1)
        elif tag == f"{W}tc":
            _walk(child, _cell(child, where), ctx, depth + 1)
        elif tag in (f"{W}del", f"{W}moveFrom"):
            _walk(child, replace(where, deleted=True), ctx, depth + 1)
        elif tag == f"{W}r":
            text = _run_text(child)
            if text:
                ctx.hit(_run_reason(child, where, ctx), text)
            _walk(child, where, ctx, depth + 1)
        elif tag in (f"{W}rPr", f"{W}pPr", f"{W}tblPr", f"{W}tcPr", f"{W}trPr", f"{W}sectPr"):
            continue
        else:
            _walk(child, where, ctx, depth + 1)


def _comments(root: Element, ctx: _Context) -> None:
    for comment in root.iter(f"{W}comment"):
        text = "\n".join(_run_text(run) for run in comment.iter(f"{W}r"))
        ctx.add("comment", text)


def _main_part(package: _Package) -> str:
    for kind, target in package.relationships(""):
        if kind == MAIN_DOCUMENT and package.has(target):
            return target
    if package.has("word/document.xml"):
        return "word/document.xml"
    raise UnreadableDocument("no main document part")


def check_docx_hidden_text(data: bytes, rules: HiddenTextRules) -> CheckOutcome:
    """Report vanished runs, near-background colour, tiny size, comments and tracked deletions as spans."""
    package = _Package(data)
    main = _main_part(package)
    related = [(kind, target) for kind, target in package.relationships(main) if package.has(target)]
    styles_part = next((target for kind, target in related if kind == "styles"), None)
    styles = _Styles.load(package.read_xml(styles_part) if styles_part else None)
    document = package.read_xml(main)
    if document is None:
        raise UnreadableDocument("no main document part")
    background = document.find(f"{W}background")
    page = (_hex(background.get(f"{W}color")) if background is not None else None) or WHITE
    ctx = _Context(styles=styles, rules=rules, spans=[])
    start = _Where(base=styles.defaults, backgrounds=(page,))
    stories = [document] + [
        root
        for root in (package.read_xml(target) for target in sorted({t for k, t in related if k in STORY_PARTS}))
        if root is not None
    ]
    for root in stories:
        _walk(root, start, ctx, 0)
        ctx.flush()
    for target in sorted({t for k, t in related if k == "comments"}):
        root = package.read_xml(target)
        if root is not None:
            _comments(root, ctx)
    return CheckOutcome(checked=True, spans=ctx.spans, link_targets=[])
