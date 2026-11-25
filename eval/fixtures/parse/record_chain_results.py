"""Records what the Phase 3 parse chain returns for the parse fixtures, for the ingest fixture mode.

Run from the repository root, in the sidecar environment with the chunking extra:

    uv run --directory rag-sidecar --extra chunking python ../eval/fixtures/parse/record_chain_results.py

Phase 3 parses a PDF once with the profile's Docling options (OCR on), so every page is taken from its structured
recording: structured_ocr where the fixture expects OCR, structured_full elsewhere. The pages are joined with the
worker's own merge helpers and passed through the sidecar adapter (to_parse_result) with the general profile, which
is the doc type the ingest mode uploads these fixtures with. chain/manifest.json maps each fixture's sha256 to its
ParseResult and artifacts in the shape of eval/fixtures/ingest/manifest.json, so the fake sidecar serves both.
The latency fixture (class bench) is left out.
"""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from typing import Any

from docling_core.types.doc import DoclingDocument

from rag_sidecar.contracts import DoclingOptions, ParseJobRequest
from rag_sidecar.contracts.ingest import ProcessingProfileSet
from rag_sidecar.ingest.merge import join_page_parts, slice_pages
from rag_sidecar.parse import docling_adapter

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
PROFILES = REPO_ROOT / "config" / "rag" / "processing-profiles.json"
DOC_TYPE = "general"
EXCLUDED_CLASSES = frozenset({"bench"})


def request_for(doc_type: str) -> ParseJobRequest:
    profiles = ProcessingProfileSet.model_validate_json(PROFILES.read_text(encoding="utf-8"))
    profile = next(item for item in profiles.profiles if item.doc_type == doc_type)
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


def chain_document(row: dict[str, Any], expected: dict[str, Any]) -> tuple[DoclingDocument, float]:
    """The whole-document parse and its text-layer page share (pages that need OCR have no text layer)."""
    parts: list[DoclingDocument] = []
    ocr_pages = 0
    for page in expected["pages"]:
        number = int(page["page"])
        preset = "structured_ocr" if page["preset"] == "structured_ocr" else "structured_full"
        ocr_pages += preset == "structured_ocr"
        doc = DoclingDocument.load_from_json(HERE / "recorded" / row["sha256"] / preset / f"page-{number}.json")
        parts.append(slice_pages(doc, {number}))
    count = len(expected["pages"])
    return join_page_parts(parts), (count - ocr_pages) / count


def build_all() -> dict[str, bytes]:
    manifest = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
    request = request_for(DOC_TYPE)
    files: dict[str, bytes] = {}
    entries: list[dict[str, Any]] = []
    for row in sorted(manifest["fixtures"], key=lambda item: item["id"]):
        if row["class"] in EXCLUDED_CLASSES:
            continue
        expected = json.loads((HERE / "expected" / f"{row['id']}.json").read_text(encoding="utf-8"))
        doc, share = chain_document(row, expected)
        with tempfile.TemporaryDirectory() as directory:
            out_dir = Path(directory)
            result = docling_adapter.to_parse_result(doc, request, out_dir, text_layer_page_share=share)
            artifacts = {name: (out_dir / name).read_bytes() for name in result.artifacts}
        parse_path = f"chain/{row['id']}.parse.json"
        files[parse_path] = _dump(result.model_dump(mode="json"))
        recorded: dict[str, Any] = {"parse_result": parse_path, "artifacts": {}}
        for name, data in artifacts.items():
            relative = f"chain/{row['id']}.{name}"
            files[relative] = _dump(json.loads(data.decode("utf-8"))) if name.endswith(".json") else data
            recorded["artifacts"][name] = relative
        entries.append(
            {
                "id": row["id"],
                "class": row["class"],
                "language": row["language"],
                "doc_type": DOC_TYPE,
                "profile_id": request.profile_id,
                "path": row["pdf_path"].removeprefix("fixtures/parse/"),
                "mime": "application/pdf",
                "file_sha256": row["sha256"],
                "page_count": row["page_count"],
                "recorded": recorded,
            }
        )
    files["chain/manifest.json"] = _dump({"schema_version": 1, "base": "eval/fixtures/parse", "fixtures": entries})
    return files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=HERE, help="fixtures/parse directory to write chain/ into")
    args = parser.parse_args(argv)
    files = build_all()
    chain = args.out / "chain"
    chain.mkdir(parents=True, exist_ok=True)
    for stale in chain.iterdir():
        if f"chain/{stale.name}" not in files:
            stale.unlink()
    for relative, data in files.items():
        (args.out / relative).write_bytes(data)
    print(f"wrote {len(files)} files under {chain}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
