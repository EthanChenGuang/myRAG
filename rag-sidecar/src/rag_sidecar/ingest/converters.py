"""Range converters: live Docling and recorded fixtures (D-21, D-53, A-4)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from docling_core.types.doc import DoclingDocument, Size

from rag_sidecar.ingest.merge import join_page_parts, merge, slice_pages
from rag_sidecar.parse import docling_adapter
from rag_sidecar.parse.converter import ConversionError
from rag_sidecar.preflight.config import load_routing_config

_UPLOAD_PRIORITY = 100

conversion_counter = 0

DEFAULT_PAGE = Size(width=595.28, height=841.89)


def reset_conversion_counter() -> None:
    global conversion_counter
    conversion_counter = 0


def _increment_conversion_counter() -> None:
    global conversion_counter
    conversion_counter += 1


class RecordedMiss(ConversionError):
    """Permanent error when a recorded page is absent."""

    def __init__(self) -> None:
        super().__init__("recorded_miss")


@dataclass(frozen=True)
class ConversionMeta:
    preset: str
    start: int
    end: int
    sub_ranges: int


class RangeConverter(Protocol):
    def convert(
        self,
        path: Path,
        file_sha256: str,
        preset: str,
        start: int,
        end: int,
        priority: int,
    ) -> tuple[DoclingDocument, dict[str, Any]]: ...


def _routing_limits() -> Any:
    return load_routing_config().ranges


def _slice_subranges(start: int, end: int, max_pages: int, priority: int) -> list[tuple[int, int]]:
    total = end - start + 1
    if priority >= _UPLOAD_PRIORITY or total <= max_pages:
        return [(start, end)]
    ranges: list[tuple[int, int]] = []
    cursor = start
    while cursor <= end:
        chunk_end = min(cursor + max_pages - 1, end)
        ranges.append((cursor, chunk_end))
        cursor = chunk_end + 1
    return ranges


def _docling_convert_range(
    path: Path,
    preset: str,
    start: int,
    end: int,
    *,
    ocr_languages: list[str] | None = None,
) -> DoclingDocument:
    return docling_adapter.convert_range(path, preset, start, end, ocr_languages=ocr_languages)


def _rechunk_json(path: Path) -> DoclingDocument:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ConversionError("invalid_docling_json")
    return DoclingDocument.model_validate(payload)


class DoclingRangeConverter:
    """Runs Docling for each sub-range and merges with original numbering."""

    def __init__(
        self,
        *,
        max_pages_per_conversion: int | None = None,
        ocr_languages: list[str] | None = None,
    ) -> None:
        limits = _routing_limits()
        self._max_pages = max_pages_per_conversion if max_pages_per_conversion is not None else limits.max_pages_per_conversion
        self._ocr_languages = ocr_languages

    def convert(
        self,
        path: Path,
        file_sha256: str,
        preset: str,
        start: int,
        end: int,
        priority: int,
    ) -> tuple[DoclingDocument, dict[str, Any]]:
        del file_sha256
        head = path.read_bytes()[:16]
        if head.lstrip().startswith(b"{"):
            return _rechunk_json(path), {"preset": preset, "start": start, "end": end, "sub_ranges": 0, "rechunk": True}
        ranges = _slice_subranges(start, end, self._max_pages, priority)
        parts: list[DoclingDocument] = []
        for sub_start, sub_end in ranges:
            parts.append(_docling_convert_range(path, preset, sub_start, sub_end, ocr_languages=self._ocr_languages))
            _increment_conversion_counter()
        if start == 1 and len(parts) > 1:
            document = merge(parts, end)
        elif len(parts) == 1:
            document = parts[0]
        else:
            document = join_page_parts(parts)
        return document, {
            "preset": preset,
            "start": start,
            "end": end,
            "sub_ranges": len(ranges),
        }


class RecordedRangeConverter:
    """Assemble a range from synthetic per-page recordings (03.1-13)."""

    def __init__(self, recorded_root: Path) -> None:
        self._root = recorded_root

    def _page_path(self, file_sha256: str, preset: str, page: int) -> Path:
        return self._root / file_sha256 / preset / f"page-{page}.json"

    def convert(
        self,
        path: Path,
        file_sha256: str,
        preset: str,
        start: int,
        end: int,
        priority: int,
    ) -> tuple[DoclingDocument, dict[str, Any]]:
        del path, priority
        parts: list[DoclingDocument] = []
        for page in range(start, end + 1):
            recorded = self._page_path(file_sha256, preset, page)
            if not recorded.is_file():
                raise RecordedMiss()
            doc = DoclingDocument.load_from_json(recorded)
            parts.append(slice_pages(doc, {page}))
            _increment_conversion_counter()
        document = join_page_parts(parts)
        return document, {"preset": preset, "start": start, "end": end, "sub_ranges": end - start + 1}


def select_range_converter(
    name: str,
    *,
    recorded_root: Path | None = None,
    max_pages_per_conversion: int | None = None,
) -> RangeConverter:
    if name == "recorded":
        root = recorded_root or (Path(__file__).resolve().parents[3] / "eval" / "fixtures" / "parse" / "recorded")
        return RecordedRangeConverter(root)
    if name == "docling":
        return DoclingRangeConverter(max_pages_per_conversion=max_pages_per_conversion)
    raise ConversionError("unsupported_converter")