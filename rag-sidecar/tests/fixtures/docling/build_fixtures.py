"""Builds the recorded DoclingDocument fixtures deterministically with docling-core.

Run `python build_fixtures.py [output-directory]` to rewrite the committed JSON files; the
contract tests compare the committed bytes with a fresh build. All content is synthetic.
"""

import json
import sys
from pathlib import Path

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

PAGE = Size(width=600, height=800)
TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGM8ISfHAANMDEgANwcANHYBDK9qubUAAAAASUVORK5CYII="
FIXTURE_NAMES = ("table-report", "headings-zh", "pictures")


def _document(name: str, pages: int, binary_hash: int) -> DoclingDocument:
    doc = DoclingDocument(
        name=name,
        origin=DocumentOrigin(mimetype="application/pdf", binary_hash=binary_hash, filename=f"{name}.pdf"),
    )
    for page_no in range(1, pages + 1):
        doc.add_page(page_no=page_no, size=PAGE)
    return doc


def _prov(page_no: int, left: float = 50, top: float = 80, right: float = 550, bottom: float = 140) -> ProvenanceItem:
    box = BoundingBox(l=left, t=top, r=right, b=bottom, coord_origin=CoordOrigin.TOPLEFT)
    return ProvenanceItem(page_no=page_no, bbox=box, charspan=(0, 0))


def _table_data(rows: list[list[str]]) -> TableData:
    cells = [
        TableCell(
            text=value,
            start_row_offset_idx=row_index,
            end_row_offset_idx=row_index + 1,
            start_col_offset_idx=col_index,
            end_col_offset_idx=col_index + 1,
            column_header=row_index == 0,
        )
        for row_index, row in enumerate(rows)
        for col_index, value in enumerate(row)
    ]
    return TableData(num_rows=len(rows), num_cols=len(rows[0]), table_cells=cells)


def build_table_report() -> DoclingDocument:
    doc = _document("table-report", pages=2, binary_hash=1001)
    doc.add_heading("Quarterly stock report", level=1, prov=_prov(1))
    doc.add_heading("Overview", level=2, prov=_prov(1))
    doc.add_text(
        DocItemLabel.TEXT,
        "This synthetic report lists the items held in the example warehouse at the end of the quarter.",
        prov=_prov(1, top=160, bottom=200),
    )
    doc.add_heading("Line items", level=2, prov=_prov(2))
    rows = [["Item", "Quantity", "Unit price", "Total"]]
    rows += [[f"Item {index:02d}", str(index), f"{index}.50", f"{index * 2}.00"] for index in range(1, 40)]
    doc.add_table(data=_table_data(rows), prov=_prov(2, top=160, bottom=760))
    return doc


def build_headings_zh() -> DoclingDocument:
    doc = _document("headings-zh", pages=2, binary_hash=1002)
    doc.add_heading("示例股份有限公司 2025 年度报告", level=1, prov=_prov(1))
    doc.add_heading("第三章 资产负债表", level=2, prov=_prov(1, top=120, bottom=160))
    doc.add_text(
        DocItemLabel.TEXT,
        "本章列示示例公司在报告期末的资产和负债情况，数据均为虚构的演示内容。",
        prov=_prov(1, top=180, bottom=240),
    )
    doc.add_heading("第5条 流动资产", level=3, prov=_prov(2))
    doc.add_text(
        DocItemLabel.TEXT,
        "流动资产包括货币资金、应收账款和存货，具体金额以附注为准。",
        prov=_prov(2, top=120, bottom=180),
    )
    return doc


def _picture_image() -> ImageRef:
    return ImageRef(
        mimetype="image/png",
        dpi=72,
        size=Size(width=4, height=4),
        uri=f"data:image/png;base64,{TINY_PNG_BASE64}",  # type: ignore[arg-type]
    )


def build_pictures() -> DoclingDocument:
    doc = _document("pictures", pages=2, binary_hash=1003)
    doc.add_heading("Product sheet", level=1, prov=_prov(1))
    doc.add_text(DocItemLabel.TEXT, "Front view of the example device.", prov=_prov(1, top=120, bottom=160))
    first_box = BoundingBox(l=100, t=700, r=300, b=500, coord_origin=CoordOrigin.BOTTOMLEFT)
    doc.add_picture(
        image=_picture_image(),
        prov=ProvenanceItem(page_no=1, bbox=first_box, charspan=(0, 0)),
    )
    doc.add_text(DocItemLabel.TEXT, "Rear view of the example device.", prov=_prov(2, top=60, bottom=100))
    doc.add_picture(
        image=_picture_image(),
        prov=_prov(2, left=50, top=100, right=550, bottom=500),
    )
    return doc


BUILDERS = {
    "table-report": build_table_report,
    "headings-zh": build_headings_zh,
    "pictures": build_pictures,
}


def render(doc: DoclingDocument) -> bytes:
    payload = doc.export_to_dict()
    return (json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def build_all() -> dict[str, bytes]:
    return {name: render(builder()) for name, builder in BUILDERS.items()}


def main(argv: list[str]) -> int:
    target = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent
    target.mkdir(parents=True, exist_ok=True)
    for name, payload in build_all().items():
        (target / f"{name}.json").write_bytes(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
