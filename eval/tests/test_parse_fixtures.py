import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from rag_eval.paths import REPO_ROOT
from rag_sidecar.contracts.parse_eval import ParserExpected
from rag_sidecar.contracts.routing import PageStructureVerdict

PARSE = REPO_ROOT / "eval/fixtures/parse"
PDF_DIR = PARSE / "pdf"
EXPECTED_DIR = PARSE / "expected"
MANIFEST = PARSE / "manifest.json"
FONT_CANDIDATES = (
    os.environ.get("RAG_FIXTURE_CJK_FONT", ""),
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
)
PRESETS = ("fast", "structured_layout", "structured_full", "structured_ocr")
CLASS_IDS = {
    "digital_text": "digital-text",
    "table": "table-en",
    "multi_column": "multi-column-en",
    "scanned_zh": "scan-zh",
    "scanned_en": "scan-en",
    "scanned_it": "scan-it",
    "invoice": "invoice-en",
    "mixed": "mixed-routing",
    "cross_boundary": "cross-boundary",
    "bench": "bench-100",
}


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _font() -> Path | None:
    for candidate in FONT_CANDIDATES:
        if not candidate:
            continue
        path = Path(candidate)
        if path.is_file():
            return path
    return None


requires_reportlab = pytest.mark.skipif(
    importlib.util.find_spec("reportlab") is None or importlib.util.find_spec("PIL") is None,
    reason="eval fixtures extra (reportlab, Pillow) is not installed",
)


def _manifest_rows():
    assert MANIFEST.is_file(), "run generate_pdfs.py --target parse"
    return json.loads(MANIFEST.read_text(encoding="utf-8"))["fixtures"]


@requires_reportlab
def test_manifest_lists_routing_fixtures():
    text = MANIFEST.read_text(encoding="utf-8")
    assert "cross-boundary" in text
    assert "bench-100" in text
    rows = _manifest_rows()
    assert len(rows) >= 10
    for key, spec_id in CLASS_IDS.items():
        assert any(row["id"] == spec_id for row in rows), key


@requires_reportlab
def test_pdfs_match_manifest_hashes():
    for row in _manifest_rows():
        data = (PDF_DIR / f"{row['id']}.pdf").read_bytes()
        assert _sha256(data) == row["sha256"]


def _snapshot(root: Path) -> dict[str, tuple[str, int]]:
    return {
        str(path.relative_to(root)): (_sha256(path.read_bytes()), path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _generate_parse(out: Path, font: Path) -> subprocess.CompletedProcess[str]:
    cmd = [
        sys.executable,
        str(REPO_ROOT / "eval/fixtures/ingest/generate_pdfs.py"),
        "--target",
        "parse",
        "--out",
        str(out),
        "--cjk-font",
        str(font),
    ]
    return subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True, env=os.environ.copy(), check=True)


def _generated_digests(out: Path) -> dict[str, str]:
    return {str(path.relative_to(out)): _sha256(path.read_bytes()) for path in sorted(out.rglob("*")) if path.is_file()}


@requires_reportlab
def test_generation_is_deterministic(tmp_path: Path):
    font = _font()
    if font is None:
        pytest.skip("no CJK font available for scanned parse fixtures")
    first = _generate_parse(tmp_path / "first", font)
    second = _generate_parse(tmp_path / "second", font)
    digest_first = _generated_digests(tmp_path / "first")
    assert "manifest.json" in digest_first
    assert len([name for name in digest_first if name.startswith("pdf/")]) == len(_manifest_rows())
    assert digest_first == _generated_digests(tmp_path / "second")
    assert first.stderr == second.stderr


@requires_reportlab
def test_generation_leaves_committed_fixtures_untouched(tmp_path: Path):
    font = _font()
    if font is None:
        pytest.skip("no CJK font available for scanned parse fixtures")
    before = _snapshot(PARSE)
    _generate_parse(tmp_path / "out", font)
    assert _snapshot(PARSE) == before
    assert (tmp_path / "out" / "manifest.json").is_file()


def test_expected_files_validate():
    ocr_hits = 0
    for row in _manifest_rows():
        path = EXPECTED_DIR / f"{row['id']}.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        ParserExpected.model_validate(payload)
        ocr_hits += sum(1 for page in payload["pages"] if page["preset"] == "structured_ocr")
    assert ocr_hits >= 3


def test_cross_boundary_marks_table_continues():
    payload = json.loads((EXPECTED_DIR / "cross-boundary.json").read_text(encoding="utf-8"))
    page4 = next(page for page in payload["pages"] if page["page"] == 4)
    assert "table_continues" in page4["signals"]
    assert page4["preset"] == "structured_full"
    page5 = next(page for page in payload["pages"] if page["page"] == 5)
    assert page5["preset"] == "structured_full"


def test_recorded_outputs_exist_for_every_page_and_preset():
    for row in _manifest_rows():
        digest = row["sha256"]
        for page in range(1, row["page_count"] + 1):
            for preset in PRESETS:
                path = PARSE / "recorded" / digest / preset / f"page-{page}.json"
                assert path.is_file(), path
                json.loads(path.read_text(encoding="utf-8"))


def test_recorded_vlm_verdicts_validate():
    specs = _load("parse_specs", PARSE / "parse_specs.py")
    rows = {row["id"]: row for row in _manifest_rows()}
    for spec in specs.fixture_specs_only():
        digest = rows[spec.id]["sha256"]
        for page in spec.facts.get("vlm_disagreement_pages", []):
            path = PARSE / "recorded" / digest / "vlm" / f"page-{page}.json"
            PageStructureVerdict.model_validate_json(path.read_text(encoding="utf-8"))


def test_recorded_premium_markdown_for_invoice_and_scanned():
    specs = _load("parse_specs", PARSE / "parse_specs.py")
    rows = {row["id"]: row for row in _manifest_rows()}
    for spec in specs.fixture_specs_only():
        if spec.doc_type != "invoice_receipt" and spec.layer != "scanned":
            continue
        digest = rows[spec.id]["sha256"]
        path = PARSE / "recorded" / digest / "premium" / "page-1.md"
        assert path.is_file(), spec.id
        assert path.read_text(encoding="utf-8").strip()