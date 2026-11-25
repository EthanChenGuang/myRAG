"""Records the parse outputs of the typed ingestion fixtures and writes the fixture manifest.

Run from the repository root, in the sidecar environment with the chunking extra:

    uv run --directory rag-sidecar --extra chunking python ../eval/fixtures/ingest/record_parse_results.py

For every fixture it builds a DoclingDocument from the spec with docling-core, runs the sidecar adapter
(to_parse_result) with the options of the fixture's processing profile, and writes <id>.parse.json
(the ParseResult), <id>.docling.json and the picture artifacts under recorded/. manifest.json maps each
fixture to its PDF, its sha256, its recordings and the facts later plans assert; the long-table fixtures are listed
under long_table_fixtures, apart from the fixtures the ingest fixture mode loads. Real Docling is not run
here; the nightly real-Docling job compares real conversions with these recordings.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import io
import json
import math
import sys
import tempfile
from pathlib import Path
from typing import Any

from docling_core.types.doc import (
    BoundingBox,
    CoordOrigin,
    DocItemLabel,
    DoclingDocument,
    ImageRef,
    ProvenanceItem,
    Size,
    TableCell,
    TableData,
)
from docling_core.types.doc.document import DocumentOrigin
from PIL import Image

from rag_sidecar.contracts import DoclingOptions, ParseJobRequest, ParseResult
from rag_sidecar.contracts.ingest import ProcessingProfileSet
from rag_sidecar.extract.invoice import extract_invoice
from rag_sidecar.parse import docling_adapter

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
PROFILES = REPO_ROOT / "config" / "rag" / "processing-profiles.json"
MARGIN_X = 56.7
MARGIN_TOP = 60.0
BODY_LEADING = 15.5
TABLE_ROW_HEIGHT = 13.6
CHARS_PER_LINE = {"zh": 36, "en": 90, "it": 90}
PICTURE_ARTIFACT = "picture-{number}.png"


def _specs() -> Any:
    loaded = sys.modules.get("ingest_fixture_specs")
    if loaded is not None:
        return loaded
    spec = importlib.util.spec_from_file_location("ingest_fixture_specs", HERE / "specs.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _prov(page: int, top: float, height: float, *, left: float = MARGIN_X, right: float | None = None, text_length: int = 0) -> ProvenanceItem:
    specs = _specs()
    box = BoundingBox(l=left, t=top, r=right if right is not None else specs.PAGE_WIDTH - MARGIN_X, b=top + height, coord_origin=CoordOrigin.TOPLEFT)
    return ProvenanceItem(page_no=page, bbox=box, charspan=(0, text_length))


def _table_data(rows: tuple[tuple[str, ...], ...], header: bool = True) -> TableData:
    cells = [
        TableCell(
            text=value,
            start_row_offset_idx=row_index,
            end_row_offset_idx=row_index + 1,
            start_col_offset_idx=col_index,
            end_col_offset_idx=col_index + 1,
            column_header=header and row_index == 0,
        )
        for row_index, row in enumerate(rows)
        for col_index, value in enumerate(row)
    ]
    return TableData(num_rows=len(rows), num_cols=len(rows[0]), table_cells=cells)


def _picture_image(name: str) -> ImageRef:
    specs = _specs()
    width, height = specs.PICTURE_PIXELS
    buffer = io.BytesIO()
    Image.frombytes("RGB", (width, height), specs.picture_rgb(name)).save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return ImageRef(mimetype="image/png", dpi=72, size=Size(width=width, height=height), uri=f"data:image/png;base64,{encoded}")  # type: ignore[arg-type]


def _text_height(text: str, language: str) -> float:
    return max(1, math.ceil(len(text) / CHARS_PER_LINE[language])) * BODY_LEADING


def build_document(spec: Any, binary_hash: int) -> DoclingDocument:
    """A DoclingDocument shaped like Docling's output for the spec: heading levels, list items, tables, pictures."""
    specs = _specs()
    doc = DoclingDocument(
        name=spec.id,
        origin=DocumentOrigin(mimetype="application/pdf", binary_hash=binary_hash, filename=f"{spec.id}.pdf"),
    )
    for page_no in range(1, spec.page_count + 1):
        doc.add_page(page_no=page_no, size=Size(width=specs.PAGE_WIDTH, height=specs.PAGE_HEIGHT))
    cursor = {page_no: MARGIN_TOP for page_no in range(1, spec.page_count + 1)}
    list_group = None
    for block in spec.blocks:
        top = cursor[block.page]
        if not isinstance(block, specs.ListItem):
            list_group = None
        if isinstance(block, specs.Heading):
            height = 26.0
            doc.add_heading(block.text, level=block.level, prov=_prov(block.page, top, height, text_length=len(block.text)))
            cursor[block.page] = top + height + 10.0
        elif isinstance(block, specs.Paragraph):
            height = _text_height(block.text, spec.language)
            doc.add_text(DocItemLabel.TEXT, block.text, prov=_prov(block.page, top, height, text_length=len(block.text)))
            cursor[block.page] = top + height + 6.0
        elif isinstance(block, specs.ListItem):
            if list_group is None:
                list_group = doc.add_list_group()
            text = block.marker + block.text
            height = _text_height(text, spec.language)
            doc.add_list_item(text, enumerated=False, parent=list_group, prov=_prov(block.page, top, height, left=MARGIN_X + 18, text_length=len(text)))
            cursor[block.page] = top + height + 3.0
        elif isinstance(block, specs.Table):
            slices = block.page_rows or (len(block.rows),)
            height = TABLE_ROW_HEIGHT * slices[0]
            table = doc.add_table(data=_table_data(block.rows, block.header), prov=_prov(block.page, top, height))
            cursor[block.page] = top + height + 10.0
            for number, count in enumerate(slices[1:], start=1):
                page_no = block.page + number
                height = TABLE_ROW_HEIGHT * count
                table.prov.append(_prov(page_no, MARGIN_TOP, height))
                cursor[page_no] = MARGIN_TOP + height + 10.0
        elif isinstance(block, specs.ColumnParagraph):
            # Columns share a top; the left one is read first, and the page moves on below the taller column.
            width = (specs.PAGE_WIDTH - 2 * MARGIN_X) / 2
            left = MARGIN_X + block.column * width
            height = 2 * _text_height(block.text, spec.language)
            doc.add_text(DocItemLabel.TEXT, block.text, prov=_prov(block.page, top, height, left=left, right=left + width - 6.0, text_length=len(block.text)))
            if block.column > 0:
                cursor[block.page] = top + height + 6.0
        elif isinstance(block, specs.Picture):
            width_pt, height_pt = specs.PICTURE_SIZE_PT
            left = (specs.PAGE_WIDTH - width_pt) / 2
            doc.add_picture(image=_picture_image(block.name), prov=_prov(block.page, top, height_pt, left=left, right=left + width_pt))
            top += height_pt + 4.0
            height = _text_height(block.caption, spec.language)
            doc.add_text(DocItemLabel.TEXT, block.caption, prov=_prov(block.page, top, height, text_length=len(block.caption)))
            cursor[block.page] = top + height + 8.0
    return doc


def request_for(spec: Any) -> ParseJobRequest:
    """The ParseJobRequest the app sends for the fixture's doc type, taken from the shipped processing profiles."""
    profiles = ProcessingProfileSet.model_validate_json(PROFILES.read_text(encoding="utf-8"))
    profile = next(item for item in profiles.profiles if item.doc_type == spec.doc_type)
    return ParseJobRequest(
        profile_id=profile.id,
        profile_version=profile.version,
        docling=DoclingOptions.model_validate(profile.parser.docling.model_dump()),
        ocr_languages=list(profile.parser.ocr_languages),
        max_tokens=profile.chunker.max_tokens,
        repeat_table_header=profile.chunker.repeat_table_header,
        input_format="pdf",
    )


def _dump(payload: Any) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _check_invoice_facts(spec: Any, result: ParseResult) -> None:
    expected = spec.facts["invoice"]
    fields = extract_invoice(result.markdown)
    found = {
        "invoice_number": fields.invoice_number,
        "issue_date": fields.issue_date.isoformat() if fields.issue_date else None,
        "due_date": fields.due_date.isoformat() if fields.due_date else None,
        "supplier": {"role": "supplier", "name": fields.supplier.name, "tax_id": fields.supplier.tax_id, "tax_id_scheme": fields.supplier.tax_id_scheme},
        "buyer": {"role": "buyer", "name": fields.buyer.name, "tax_id": fields.buyer.tax_id, "tax_id_scheme": fields.buyer.tax_id_scheme},
        "currency": fields.currency,
        "net_total": fields.net_total,
        "tax_total": fields.tax_total,
        "gross_total": fields.gross_total,
        "line_item_count": len(fields.line_items),
    }
    if found != expected or fields.errors:
        raise SystemExit(f"{spec.id}: the recorded markdown does not yield the expected invoice facts: {found} {fields.errors}")


def record_fixture(spec: Any, binary_hash: int) -> tuple[ParseResult, dict[str, bytes]]:
    """Runs the adapter on the spec's document; returns the ParseResult and the artifact files by name."""
    doc = build_document(spec, binary_hash)
    share = 0.0 if spec.layer == "scanned" else 1.0
    with tempfile.TemporaryDirectory() as directory:
        out_dir = Path(directory)
        result = docling_adapter.to_parse_result(doc, request_for(spec), out_dir, text_layer_page_share=share)
        artifacts = {name: (out_dir / name).read_bytes() for name in result.artifacts}
    return result, artifacts


def build_all(pdf_dir: Path) -> dict[str, bytes]:
    """Every file this recorder owns, by path relative to eval/fixtures/ingest."""
    specs = _specs()
    build_info = json.loads((pdf_dir / "build-info.json").read_text(encoding="utf-8"))
    files: dict[str, bytes] = {}
    entries = _record_entries(specs.all_specs(), pdf_dir, files, first_hash=2000)
    long_table_entries = _record_entries(specs.long_table_specs(), pdf_dir, files, first_hash=3000)
    from importlib.metadata import version

    manifest = {
        "schema_version": 1,
        "generator": build_info["generator"],
        "scan_font": build_info["scan_font"],
        "recorded_with": {"adapter": "rag_sidecar.parse.docling_adapter.to_parse_result", "docling_core": version("docling-core"), "tokenizer": "cl100k_base"},
        "fixtures": entries,
        "long_table_fixtures": long_table_entries,
    }
    files["manifest.json"] = _dump(manifest)
    return files


def _record_entries(fixture_specs: Any, pdf_dir: Path, files: dict[str, bytes], first_hash: int) -> list[dict[str, Any]]:
    """Records each spec into files and returns its manifest entries, in spec order."""
    entries: list[dict[str, Any]] = []
    for index, spec in enumerate(fixture_specs, start=1):
        pdf_path = pdf_dir / f"{spec.id}.pdf"
        pdf_bytes = pdf_path.read_bytes()
        result, artifacts = record_fixture(spec, binary_hash=first_hash + index)
        if "invoice" in spec.facts:
            _check_invoice_facts(spec, result)
        recorded: dict[str, Any] = {"artifacts": {}}
        parse_path = f"recorded/{spec.id}.parse.json"
        files[parse_path] = _dump(result.model_dump(mode="json"))
        recorded["parse_result"] = parse_path
        for name, data in artifacts.items():
            if name == docling_adapter.DOCLING_JSON:
                relative = f"recorded/{spec.id}.docling.json"
                files[relative] = _dump(json.loads(data.decode("utf-8")))
                recorded["docling"] = relative
            else:
                relative = f"recorded/{spec.id}.{name}"
                files[relative] = data
            recorded["artifacts"][name] = relative
        entry: dict[str, Any] = {
            "id": spec.id,
            "language": spec.language,
            "doc_type": spec.doc_type,
            "profile_id": request_for(spec).profile_id,
            "text_layer": spec.layer,
            "path": f"pdf/{spec.id}.pdf",
            "mime": "application/pdf",
            "file_sha256": hashlib.sha256(pdf_bytes).hexdigest(),
            "size_bytes": len(pdf_bytes),
            "recorded": recorded,
            "expected": json.loads(json.dumps(spec.facts)),
        }
        if spec.write_text:
            text_bytes = (HERE / "text" / f"{spec.id}.md").read_bytes()
            entry["text"] = {"path": f"text/{spec.id}.md", "mime": "text/markdown", "sha256": hashlib.sha256(text_bytes).hexdigest()}
        entries.append(entry)
    return entries


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pdf-dir", type=Path, default=HERE / "pdf", help="directory holding the fixture PDFs and build-info.json")
    parser.add_argument("--out", type=Path, default=HERE, help="fixtures/ingest directory to write recorded/ and manifest.json into")
    args = parser.parse_args(argv)
    files = build_all(args.pdf_dir)
    recorded = args.out / "recorded"
    recorded.mkdir(parents=True, exist_ok=True)
    for stale in recorded.iterdir():
        if f"recorded/{stale.name}" not in files:
            stale.unlink()
    for relative, data in files.items():
        (args.out / relative).write_bytes(data)
    print(f"wrote {len(files)} files under {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
