"""Synthetic per-page, per-preset recorded outputs for parse routing tests."""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

from rag_sidecar.contracts.routing import PageStructureVerdict

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "manifest.json"
RECORDED = HERE / "recorded"
PRESETS = ("fast", "structured_layout", "structured_full", "structured_ocr")


def _load(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _dump(data: Any) -> bytes:
    return (json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def page_blocks(spec: Any, page: int, ingest: Any) -> tuple[Any, ...]:
    return tuple(block for block in spec.blocks if block.page == page)


def base_page_payload(spec: Any, page: int, ingest: Any, recorder: Any) -> dict[str, Any]:
    share = 0.0 if spec.facts.get("page_kinds", {}).get(page) == "scanned" else 1.0
    mini = ingest.FixtureSpec(
        f"{spec.id}-p{page}",
        spec.language,
        spec.doc_type,
        "scanned" if share == 0.0 else "digital",
        page_blocks(spec, page, ingest),
        {"page_count": 1},
    )
    doc = recorder.build_document(mini, binary_hash=page)
    return doc.export_to_dict()


def tune_payload(payload: dict[str, Any], preset: str, scanned: bool, has_table: bool) -> dict[str, Any]:
    tuned = copy.deepcopy(payload)
    if scanned and preset == "fast":
        tuned["texts"] = []
        tuned["tables"] = []
        return tuned
    if scanned and preset == "structured_ocr":
        return tuned
    if has_table and preset == "fast":
        for table in tuned.get("tables", []):
            if "data" in table and "table_cells" in table["data"]:
                table["data"]["table_cells"] = []
        return tuned
    if has_table and preset == "structured_layout":
        for table in tuned.get("tables", []):
            if "data" in table and "table_cells" in table["data"]:
                table["data"]["table_cells"] = []
    return tuned


def premium_markdown(spec: Any, page: int, ingest: Any) -> str:
    lines = [block.text for block in page_blocks(spec, page, ingest) if hasattr(block, "text")]
    return "\n\n".join(lines) + "\n"


def vlm_verdict(page: int, spec: Any) -> PageStructureVerdict:
    has_table = page in spec.facts.get("tables", {})
    has_multi = page in spec.facts.get("multi_column_pages", set())
    scanned = spec.facts.get("page_kinds", {}).get(page) == "scanned"
    return PageStructureVerdict(
        has_table=has_table,
        has_multi_column=has_multi,
        is_scanned=scanned,
        has_formula=False,
        has_chart=False,
        complexity="complex" if has_table and has_multi else "simple",
        confidence=0.91,
    )


def build_all() -> dict[str, bytes]:
    ingest = _load("ingest_fixture_specs", HERE.parent / "ingest" / "specs.py")
    parse_mod = _load("parse_fixture_specs_module", HERE / "parse_specs.py")
    recorder = _load("ingest_record_parse", HERE.parent / "ingest" / "record_parse_results.py")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    by_id = {row["id"]: row for row in manifest["fixtures"]}
    files: dict[str, bytes] = {}
    for spec in parse_mod.fixture_specs_only():
        row = by_id[spec.id]
        digest = row["sha256"]
        for page in range(1, row["page_count"] + 1):
            base = base_page_payload(spec, page, ingest, recorder)
            scanned = spec.facts.get("page_kinds", {}).get(page) == "scanned"
            has_table = page in spec.facts.get("tables", {})
            for preset in PRESETS:
                rel = f"recorded/{digest}/{preset}/page-{page}.json"
                files[rel] = _dump(tune_payload(base, preset, scanned, has_table))
            kind = spec.facts.get("page_kinds", {}).get(page, spec.layer)
            if kind == "scanned" or spec.doc_type == "invoice_receipt":
                rel = f"recorded/{digest}/premium/page-{page}.md"
                files[rel] = premium_markdown(spec, page, ingest).encode("utf-8")
        for page in spec.facts.get("vlm_disagreement_pages", []):
            rel = f"recorded/{digest}/vlm/page-{page}.json"
            files[rel] = _dump(vlm_verdict(page, spec).model_dump(mode="json"))
    bench = next(item for item in parse_mod.all_specs() if getattr(item, "id", "") == "bench-100")
    row = by_id["bench-100"]
    digest = row["sha256"]
    mini = ingest.FixtureSpec("bench-100", "en", "financial_report", "digital", (), {"page_count": 1})
    for page in range(1, bench.page_count + 1):
        text_blocks = (ingest.Paragraph(f"Benchmark page {page}", 1),)
        if page in bench.table_pages:
            text_blocks = (ingest.Paragraph(f"Benchmark page {page}", 1), ingest.Table((("Metric", "Value"), (f"Page-{page}", "42")), 1))
        page_spec = ingest.FixtureSpec(f"bench-100-p{page}", "en", "financial_report", "digital", text_blocks, {"page_count": 1})
        base = recorder.build_document(page_spec, page).export_to_dict()
        for preset in PRESETS:
            rel = f"recorded/{digest}/{preset}/page-{page}.json"
            files[rel] = _dump(tune_payload(base, preset, False, page in bench.table_pages))
    return files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--real", action="store_true", help="record from live Docling (not used in CI)")
    args = parser.parse_args(argv)
    if args.real:
        print("real recording is a live check item (plan 03.1-54); CI uses synthetic recordings only", file=sys.stderr)
        return 2
    if not MANIFEST.is_file():
        parser.error(f"missing {MANIFEST}; run generate_pdfs.py --target parse first")
    files = build_all()
    for relative, data in files.items():
        path = HERE / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    print(f"wrote {len(files)} recorded files under {RECORDED}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())