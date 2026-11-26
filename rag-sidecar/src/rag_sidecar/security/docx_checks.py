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

import posixpath
import zipfile
from dataclasses import dataclass, field
from typing import Any
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
            self._zip = zipfile.ZipFile(_bytes_io(data))
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


def _bytes_io(data: bytes) -> Any:
    import io

    return io.BytesIO(data)


def _on(element: Element | None) -> bool | None:
    """A toggle property: absent -> None, present -> on unless w:val says off."""
    if element is None:
        return None
    value = element.get(f"{W}val")
    return value is None or value.strip().lower() not in OFF_VALUES


@dataclass
class _Props:
    vanish: bool | None = None

    def merged(self, rpr: Element | None) -> _Props:
        if rpr is None:
            return self
        vanish = _on(rpr.find(f"{W}vanish"))
        return _Props(vanish=self.vanish if vanish is None else vanish)


@dataclass
class _Style:
    based_on: str | None
    rpr: Element | None


@dataclass
class _Styles:
    defaults: _Props = field(default_factory=_Props)
    styles: dict[str, _Style] = field(default_factory=dict)
    default_paragraph: str | None = None
    cache: dict[str, _Props] = field(default_factory=dict)

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
            based = style.find(f"{W}basedOn")
            styles[style_id] = _Style(based_on=based.get(f"{W}val") if based is not None else None, rpr=style.find(f"{W}rPr"))
            is_default = (style.get(f"{W}default") or "").lower() in {"1", "true", "on"}
            if style.get(f"{W}type") == "paragraph" and is_default and default_paragraph is None:
                default_paragraph = style_id
        return cls(defaults=defaults, styles=styles, default_paragraph=default_paragraph)

    def chain(self, style_id: str | None) -> list[Element]:
        """rPr elements of a style chain, base first; cycles and over-long chains stop."""
        out: list[Element | None] = []
        seen: set[str] = set()
        current = style_id
        while current and current not in seen and len(seen) < MAX_STYLE_CHAIN:
            seen.add(current)
            style = self.styles.get(current)
            if style is None:
                break
            out.append(style.rpr)
            current = style.based_on
        return [rpr for rpr in reversed(out) if rpr is not None]

    def apply(self, base: _Props, style_id: str | None) -> _Props:
        props = base
        for rpr in self.chain(style_id):
            props = props.merged(rpr)
        return props


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
    paragraph: _Props
    deleted: bool = False


def _run_reason(run: Element, where: _Where, ctx: _Context) -> HiddenTextSpanReason | None:
    rpr = run.find(f"{W}rPr")
    props = ctx.styles.apply(where.paragraph, _val(rpr, "rStyle")).merged(rpr)
    if props.vanish:
        return "vanished_run"
    return None


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
            ppr = child.find(f"{W}pPr")
            style_id = _val(ppr, "pStyle") or ctx.styles.default_paragraph
            paragraph = ctx.styles.apply(ctx.styles.defaults, style_id)
            _walk(child, _Where(paragraph=paragraph, deleted=where.deleted), ctx, depth + 1)
            ctx.flush()
        elif tag == f"{W}r":
            text = _run_text(child)
            if text:
                ctx.hit(_run_reason(child, where, ctx), text)
            _walk(child, where, ctx, depth + 1)
        elif tag in (f"{W}rPr", f"{W}pPr"):
            continue
        else:
            _walk(child, where, ctx, depth + 1)


def _story_parts(package: _Package, main: str) -> list[str]:
    parts = [main]
    related = package.relationships(main)
    parts.extend(sorted({target for kind, target in related if kind in STORY_PARTS and package.has(target)}))
    return parts


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
    related = package.relationships(main)
    styles_part = next((target for kind, target in related if kind == "styles"), None)
    styles = _Styles.load(package.read_xml(styles_part) if styles_part else None)
    ctx = _Context(styles=styles, rules=rules, spans=[])
    for part in _story_parts(package, main):
        root = package.read_xml(part)
        if root is None:
            continue
        _walk(root, _Where(paragraph=styles.defaults), ctx, 0)
        ctx.flush()
    return CheckOutcome(checked=True, spans=ctx.spans, link_targets=[])
