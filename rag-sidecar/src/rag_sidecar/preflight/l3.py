"""L3 preflight: vision-model verdicts for pages on which L1 and L2 disagree (D-49, D-50)."""

from __future__ import annotations

import asyncio
import base64
import logging
import struct
import zlib
from collections.abc import Sequence
from dataclasses import dataclass, fields, replace
from pathlib import Path
from typing import Any, Protocol

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from rag_sidecar.contracts.queue import (
    DetectVlmPageImage,
    DetectVlmRequest,
    DetectVlmResponse,
    JobSettingsSnapshot,
)
from rag_sidecar.contracts.routing import PageSignal, PageStructureVerdict, ParseRoutingConfig
from rag_sidecar.preflight.l1 import PageL1
from rag_sidecar.preflight.l2 import L2Page

logger = logging.getLogger(__name__)

# The app route accepts at most this many images per call; the routing data may only lower it.
MAX_VLM_PAGES = 20
RENDER_SCALE = 1.5
MAX_SIDE_PX = 2000
MAX_IMAGE_BYTES = 7 * 1024 * 1024
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# Facts L1 reads off the page text, not judgements of the layout model, so a verdict does not replace them.
_KEPT_SIGNALS: tuple[PageSignal, ...] = ("garbled", "table_continues")


class VlmApp(Protocol):
    """The app's detect-vlm route as the preflight sees it: synchronous, because preflight runs in a pool thread."""

    def detect(self, pages: Sequence[tuple[int, bytes]]) -> DetectVlmResponse: ...


@dataclass
class L3Page(L2Page):
    """A page whose L1 and L2 signals were replaced by an L3 verdict."""

    verdict: PageStructureVerdict | None = None
    l3_examined: bool = False


class LoopVlmApp:
    """Calls the worker's async AppClient from a pool thread by handing the coroutine to the loop that owns the client."""

    def __init__(
        self,
        client: Any,
        job_id: str,
        worker_id: str,
        attempt_no: int,
        loop: asyncio.AbstractEventLoop,
        timeout_s: float = 60.0,
    ) -> None:
        self._client = client
        self._job_id = job_id
        self._worker_id = worker_id
        self._attempt_no = attempt_no
        self._loop = loop
        self._timeout_s = timeout_s

    def detect(self, pages: Sequence[tuple[int, bytes]]) -> DetectVlmResponse:
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            raise RuntimeError("detect must not run on the loop that serves the client")
        request = DetectVlmRequest(
            worker_id=self._worker_id,
            attempt_no=self._attempt_no,
            pages=[
                DetectVlmPageImage(page=number, png_base64=base64.b64encode(blob).decode("ascii")) for number, blob in pages
            ],
        )
        future = asyncio.run_coroutine_threadsafe(self._client.detect_vlm(self._job_id, request), self._loop)
        try:
            return future.result(timeout=self._timeout_s)
        except BaseException:
            future.cancel()
            raise


def _chunk(tag: bytes, data: bytes) -> bytes:
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def _encode_png(width: int, height: int, rgb: bytes, stride: int) -> bytes:
    row_bytes = width * 3
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw += rgb[y * stride : y * stride + row_bytes]
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return _PNG_SIGNATURE + _chunk(b"IHDR", header) + _chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + _chunk(b"IEND", b"")


def render_pages(path: Path | str, page_numbers: Sequence[int]) -> list[tuple[int, bytes]]:
    """Render 1-based pages to PNG bytes. A page that cannot be rendered, or whose image is too large, is left out."""
    out: list[tuple[int, bytes]] = []
    pdf = pdfium.PdfDocument(str(path))
    try:
        for number in page_numbers:
            try:
                page = pdf[number - 1]
                try:
                    width_pt, height_pt = page.get_size()
                    scale = min(RENDER_SCALE, MAX_SIDE_PX / max(width_pt, height_pt, 1.0))
                    bitmap = page.render(
                        scale=scale,
                        rev_byteorder=True,
                        force_bitmap_format=pdfium_c.FPDFBitmap_BGR,
                    )
                    blob = _encode_png(bitmap.width, bitmap.height, bytes(bitmap.buffer), bitmap.stride)
                finally:
                    page.close()
            except Exception as exc:
                logger.warning("l3 page render failed (%s)", type(exc).__name__)
                continue
            if len(blob) > MAX_IMAGE_BYTES:
                logger.warning("l3 page skipped: rendered image over the size cap")
                continue
            out.append((number, blob))
    finally:
        pdf.close()
    return out


def l3_enabled(snapshot: JobSettingsSnapshot | None) -> bool:
    """Whether the job snapshot asks for L3; the app's guard is the authority, the worker only skips what the snapshot forbids (D-18)."""
    return (
        snapshot is not None
        and snapshot.vlm_detect
        and snapshot.routing == "tiered"
        and snapshot.cloud_allowed
        and snapshot.premium_page_budget > 0
    )


def _verdict_signals(l1: PageL1, verdict: PageStructureVerdict) -> list[PageSignal]:
    signals: list[PageSignal] = []
    if verdict.has_table:
        signals.append("tables")
    if verdict.has_multi_column:
        signals.append("multi_col")
    if verdict.has_chart:
        signals.append("has_figure")
    if verdict.is_scanned:
        signals.append("scanned")
    signals.extend(signal for signal in _KEPT_SIGNALS if signal in l1.signals and signal not in signals)
    return signals


def _apply_verdict(page: L2Page, verdict: PageStructureVerdict) -> L3Page:
    l1 = replace(
        page.l1,
        signals=_verdict_signals(page.l1, verdict),
        scanned=verdict.is_scanned,
        multi_column=verdict.has_multi_column,
        has_figure=verdict.has_chart,
        uncertain=False,
    )
    carried = {field.name: getattr(page, field.name) for field in fields(L2Page)}
    carried.update(
        l1=l1,
        l2_has_table=verdict.has_table,
        has_structure=verdict.has_table or verdict.has_chart or verdict.has_formula,
        uncertain=False,
        layer="L3",
    )
    return L3Page(**carried, verdict=verdict, l3_examined=True)


def l3_refine(
    pages: list[L2Page],
    disagreements: list[int],
    path: Path | str,
    snapshot: JobSettingsSnapshot | None,
    app_client: VlmApp,
    cfg: ParseRoutingConfig,
) -> list[L2Page]:
    """Replace L1 and L2 signals with vision verdicts for disagreement pages.

    Runs only when the job snapshot asks for it, for at most `l3.max_pages_per_doc` pages in page order. A refused page, a failed
    page or a failing call leaves the pages as they are, so the higher tier of L1 and L2 stands (D-49); it never raises.
    """
    limit = min(cfg.l3.max_pages_per_doc, MAX_VLM_PAGES)
    if limit <= 0 or not l3_enabled(snapshot):
        return pages
    known = {page.page for page in pages}
    targets = sorted({number for number in disagreements if number in known})[:limit]
    if not targets:
        return pages

    try:
        images = render_pages(path, targets)
        if not images:
            return pages
        response = app_client.detect(images)
    except Exception as exc:
        logger.warning("l3 vision call failed (%s)", type(exc).__name__)
        return pages

    sent = {number for number, _blob in images}
    verdicts: dict[int, PageStructureVerdict] = {}
    for item in response.pages:
        if item.page in sent and item.verdict is not None and item.refused is None and item.page not in verdicts:
            verdicts[item.page] = item.verdict
    logger.info("l3 vision verdicts: %d of %d pages", len(verdicts), len(sent))
    if not verdicts:
        return pages
    return [_apply_verdict(page, verdicts[page.page]) if page.page in verdicts else page for page in pages]
