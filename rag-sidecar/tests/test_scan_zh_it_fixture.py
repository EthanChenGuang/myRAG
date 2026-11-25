"""The scan_zh_it parse fixture (03.2-25, D-18): the engine code the sidecar derives from the recorded Docling request."""

import json
from pathlib import Path

from rag_sidecar.parse.docling_adapter import to_ppocr_code

PARSE = Path(__file__).resolve().parents[2] / "eval" / "fixtures" / "parse"


def _requests_dir() -> Path:
    rows = [row for row in json.loads((PARSE / "manifest.json").read_text(encoding="utf-8"))["fixtures"] if row["id"] == "scan-zh-it"]
    assert len(rows) == 1, "scan-zh-it is not in the parse manifest"
    return PARSE / "recorded" / rows[0]["sha256"] / "requests"


def test_the_engine_code_of_the_recorded_docling_request_is_the_recorded_one():
    base = _requests_dir()
    assert (base / "docling.json").is_file() and (base / "docling-engine.json").is_file()
    request = json.loads((base / "docling.json").read_text(encoding="utf-8"))
    engine = json.loads((base / "docling-engine.json").read_text(encoding="utf-8"))
    assert request["ocr_languages"] == ["zh", "it"]
    assert to_ppocr_code(request["ocr_languages"]) == engine["ocr_engine_codes"] == ["ch"]
