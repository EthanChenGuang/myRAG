"""Test-only launcher for tests/rag-e2e/ingest-latency.test.mts (D-45, SC5).

`slice SRC DST FIRST LAST` copies pages FIRST..LAST (1-based) of a PDF into a new PDF.
`serve PORT` serves rag_sidecar.main:app; with LATENCY_CONVERTER_DELAY_MS > 0 every recorded range conversion (one per sub-range)
first sleeps that long, which stands in for a slow Docling conversion while a backfill runs.
"""

from __future__ import annotations

import os
import sys
import time


def _slice(src: str, dst: str, first: int, last: int) -> None:
    import pypdfium2 as pdfium

    source = pdfium.PdfDocument(src)
    out = pdfium.PdfDocument.new()
    out.import_pages(source, list(range(first - 1, last)))
    out.save(dst)


def _serve(port: int) -> None:
    delay_s = int(os.environ.get("LATENCY_CONVERTER_DELAY_MS", "0")) / 1000
    if delay_s > 0:
        from rag_sidecar.ingest import converters

        recorded_convert = converters.RecordedRangeConverter.convert

        def slow_convert(self, path, file_sha256, preset, start, end, priority):  # type: ignore[no-untyped-def]
            time.sleep(delay_s)
            return recorded_convert(self, path, file_sha256, preset, start, end, priority)

        converters.RecordedRangeConverter.convert = slow_convert  # type: ignore[method-assign]

    import uvicorn

    uvicorn.run("rag_sidecar.main:app", host="127.0.0.1", port=port, log_level="warning")


def main(argv: list[str]) -> int:
    if len(argv) == 5 and argv[0] == "slice":
        _slice(argv[1], argv[2], int(argv[3]), int(argv[4]))
        return 0
    if len(argv) == 2 and argv[0] == "serve":
        _serve(int(argv[1]))
        return 0
    print("usage: latency_sidecar slice SRC DST FIRST LAST | serve PORT", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
