import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from rag_sidecar.contracts.languages import LANGUAGE_CODES

from rag_eval.paths import resolve_cli_path

CORPUS_LANGUAGES: tuple[str, ...] = LANGUAGE_CODES
DEFAULT_CREATED_AT = "2025-01-15T00:00:00.000Z"
CHUNK_MARKER = "<!-- chunk -->"
CORPUS_DOC_TYPES = frozenset(
    {"financial_report", "contract_legal", "invoice_receipt", "product_technical", "scanned_image", "general"}
)
DEFAULT_DOC_TYPE = "general"

# JavaScript's String.prototype.trim and the \s class use this exact whitespace set, which differs from
# Python's str.strip at \x1c-\x1f and \x85 and at U+FEFF; the TS loader (eval/harness/corpus.mts) defines parity.
_JS_WS = "\t\n\x0b\x0c\r \xa0\u1680" + "".join(chr(c) for c in range(0x2000, 0x200B)) + "\u2028\u2029\u202f\u205f\u3000\ufeff"
_NOT_EOL = "^\n\r\u2028\u2029"
_META_RE = re.compile(rf"^<!--[{_JS_WS}]*fixture-meta[{_JS_WS}]+(\{{[{_NOT_EOL}]*\}})[{_JS_WS}]*-->[{_JS_WS}]*$")
_HEADING_RE = re.compile(rf"^#{{1,6}}[{_JS_WS}]+([{_NOT_EOL}]*[^{_JS_WS}])[{_JS_WS}]*$")


@dataclass(frozen=True)
class CorpusChunk:
    index: int
    section: str
    text: str
    stored: str


@dataclass(frozen=True)
class CorpusDocument:
    relpath: str
    language: str
    filename: str
    image_url: str | None
    created_at: str
    content: str
    chunks: list[CorpusChunk]
    doc_type: str | None = None
    fixture_dup_template: str | None = None
    lineage: str | None = None
    version: int | None = None
    version_label: str | None = None
    effective_from: str | None = None


def _js_trim(text: str) -> str:
    return text.strip(_JS_WS)


def _first_heading(text: str) -> str:
    for line in text.split("\n"):
        match = _HEADING_RE.match(line)
        if match:
            return match.group(1)
    return ""


def _resolve_doc_type(meta: dict, relpath: str) -> str:
    raw = meta.get("doc_type")
    if raw is None:
        return DEFAULT_DOC_TYPE
    if not isinstance(raw, str) or raw not in CORPUS_DOC_TYPES:
        raise ValueError(f"[Fixture Corpus] invalid doc_type in {relpath}")
    return raw


def _parse_meta(line: str, relpath: str) -> dict:
    match = _META_RE.match(_js_trim(line))
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(1))
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        return parsed
    raise ValueError(f"[Fixture Corpus] invalid fixture-meta JSON in {relpath}")


_GENERATE_KEYS = frozenset({"count", "name", "substitutions", "template_id"})
GENERATE_MAX_COUNT = 100


def _is_integer(value: object) -> bool:
    # JSON numbers: JavaScript cannot tell 30 from 30.0, so an integral float counts as an integer in both loaders.
    if isinstance(value, bool):
        return False
    return isinstance(value, int) or (isinstance(value, float) and value.is_integer())


def _parse_generate(raw: object, meta: dict, relpath: str) -> dict:
    error = ValueError(f"[Fixture Corpus] invalid generate block in {relpath}")
    if not isinstance(raw, dict) or set(raw) != _GENERATE_KEYS:
        raise error
    count, name, substitutions, template_id = raw["count"], raw["name"], raw["substitutions"], raw["template_id"]
    if not _is_integer(count) or not 1 <= count <= GENERATE_MAX_COUNT:
        raise error
    if not isinstance(name, str) or "{n}" not in name or "/" in name or "\\" in name:
        raise error
    if not isinstance(template_id, str) or not template_id:
        raise error
    if not isinstance(substitutions, list):
        raise error
    for pair in substitutions:
        if not (isinstance(pair, list) and len(pair) == 2 and all(isinstance(part, str) for part in pair) and pair[0]):
            raise error
    if any(key in meta for key in ("filename", "lineage", "version", "version_label", "effective_from")):
        raise error
    return {"count": int(count), "name": name, "substitutions": substitutions, "template_id": template_id}


def _parse_lineage(meta: dict, relpath: str) -> tuple[str | None, int | None]:
    if "lineage" not in meta:
        return None, None
    lineage, version = meta.get("lineage"), meta.get("version")
    if not isinstance(lineage, str) or not lineage or not _is_integer(version) or version < 1:
        raise ValueError(f"[Fixture Corpus] invalid lineage in {relpath}")
    return lineage, int(version)


_ISO_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def _is_iso_date(value: object) -> bool:
    if not isinstance(value, str) or not _ISO_DATE_RE.match(value):
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _parse_version_fields(meta: dict, relpath: str, has_lineage: bool) -> dict:
    """version (only without a lineage), version_label and effective_from, as the TypeScript loader reads them (05.2 D-49, D-52)."""
    fields: dict = {}
    if not has_lineage and "version" in meta:
        version = meta["version"]
        if not _is_integer(version) or version < 1:
            raise ValueError(f"[Fixture Corpus] invalid version in {relpath}")
        fields["version"] = int(version)
    if "version_label" in meta:
        label = meta["version_label"]
        if not isinstance(label, str) or not _js_trim(label) or len(label) > 64:
            raise ValueError(f"[Fixture Corpus] invalid version_label in {relpath}")
        fields["version_label"] = label
    if "effective_from" in meta:
        if not _is_iso_date(meta["effective_from"]):
            raise ValueError(f"[Fixture Corpus] invalid effective_from in {relpath} (expected YYYY-MM-DD)")
        fields["effective_from"] = meta["effective_from"]
    return fields


def _build_document(
    relpath: str,
    filename: str,
    lines: list[str],
    meta: dict,
    fixture_dup_template: str | None = None,
    lineage: str | None = None,
    version: int | None = None,
    version_label: str | None = None,
    effective_from: str | None = None,
) -> CorpusDocument:
    language = relpath.split("/", 1)[0]
    parts: list[str] = []
    current: list[str] = []
    for line in lines:
        if line == CHUNK_MARKER:
            parts.append("\n".join(current))
            current = []
        else:
            current.append(line)
    parts.append("\n".join(current))
    texts = [trimmed for trimmed in (_js_trim(part) for part in parts) if trimmed]
    return CorpusDocument(
        relpath=relpath,
        language=language,
        filename=filename,
        image_url=meta["image_url"] if isinstance(meta.get("image_url"), str) else None,
        created_at=meta["created_at"] if isinstance(meta.get("created_at"), str) else DEFAULT_CREATED_AT,
        content="\n\n".join(texts),
        chunks=[
            CorpusChunk(
                index=index,
                section=_first_heading(text),
                text=text,
                stored=f"Document: {filename}. Chunk {index + 1} of {len(texts)}. Content: {text}",
            )
            for index, text in enumerate(texts)
        ],
        doc_type=_resolve_doc_type(meta, relpath),
        fixture_dup_template=fixture_dup_template,
        lineage=lineage,
        version=version,
        version_label=version_label,
        effective_from=effective_from,
    )


def _expand_template(relpath: str, lines: list[str], meta: dict, generate: dict) -> list[CorpusDocument]:
    """D-20/D-50: one committed template becomes `count` documents; copy i applies substitution i mod len and ends with its own chunk."""
    language = relpath.split("/", 1)[0]
    count, substitutions, template_id = generate["count"], generate["substitutions"], generate["template_id"]
    width = max(2, len(str(count)))
    body = "\n".join(lines)
    copies: list[CorpusDocument] = []
    for i in range(count):
        number = str(i + 1).zfill(width)
        text = body
        if substitutions:
            source, target = substitutions[i % len(substitutions)]
            text = text.replace(source, target)
        filename = generate["name"].replace("{n}", number)
        copy_lines = [*text.split("\n"), CHUNK_MARKER, f"{template_id}-{number}"]
        copies.append(_build_document(f"{language}/{filename}", filename, copy_lines, meta, fixture_dup_template=template_id))
    return copies


def _corpus_relpaths(corpus_dir: Path) -> list[str]:
    relpaths: list[str] = []
    for language in CORPUS_LANGUAGES:
        lang_dir = corpus_dir / language
        if not lang_dir.is_dir():
            continue
        for entry in lang_dir.iterdir():
            if entry.name.endswith(".md") and entry.is_file():
                relpaths.append(f"{language}/{entry.name}")
    relpaths.sort()
    return relpaths


def load_corpus(corpus_dir: Path) -> list[CorpusDocument]:
    corpus_dir = Path(corpus_dir)
    documents: list[CorpusDocument] = []
    for relpath in _corpus_relpaths(corpus_dir):
        raw = (corpus_dir / relpath).read_bytes().decode("utf-8", errors="replace")
        lines = raw.replace("\r\n", "\n").split("\n")
        meta: dict = {}
        if _META_RE.match(_js_trim(lines[0])):
            meta = _parse_meta(lines.pop(0), relpath)
        if "generate" in meta:
            documents.extend(_expand_template(relpath, lines, meta, _parse_generate(meta["generate"], meta, relpath)))
            continue
        lineage, version = _parse_lineage(meta, relpath)
        fields = _parse_version_fields(meta, relpath, lineage is not None)
        if lineage is None:
            version = fields.get("version")
        filename = meta["filename"] if isinstance(meta.get("filename"), str) else relpath.rsplit("/", 1)[-1]
        documents.append(
            _build_document(
                relpath,
                filename,
                lines,
                meta,
                lineage=lineage,
                version=version,
                version_label=fields.get("version_label"),
                effective_from=fields.get("effective_from"),
            )
        )

    seen: set[str] = set()
    versions: set[tuple[str, int]] = set()
    for doc in documents:
        if doc.relpath in seen:
            raise ValueError(f"[Fixture Corpus] duplicate corpus document {doc.relpath}")
        seen.add(doc.relpath)
        if doc.lineage is not None and doc.version is not None:
            if (doc.lineage, doc.version) in versions:
                raise ValueError(f"[Fixture Corpus] duplicate lineage version {doc.lineage} {doc.version}")
            versions.add((doc.lineage, doc.version))
    documents.sort(key=lambda doc: doc.relpath)
    return documents


def corpus_sha256(corpus_dir: Path) -> str:
    """The TypeScript loader's corpusSha256: committed file bytes only, so generated documents add nothing (D-50)."""
    corpus_dir = Path(corpus_dir)
    digest = hashlib.sha256()
    for relpath in _corpus_relpaths(corpus_dir):
        digest.update(relpath.encode("utf-8"))
        digest.update(b"\x00")
        digest.update((corpus_dir / relpath).read_bytes())
    return digest.hexdigest()


def _dump(corpus_dir: Path) -> str:
    payload = []
    for doc in load_corpus(corpus_dir):
        entry: dict = {
            "relpath": doc.relpath,
            "filename": doc.filename,
            "language": doc.language,
            "doc_type": doc.doc_type,
            "chunks": [
                {"index": c.index, "section": c.section, "text": c.text, "stored": c.stored} for c in doc.chunks
            ],
        }
        if doc.fixture_dup_template is not None:
            entry["fixture_dup_template"] = doc.fixture_dup_template
        if doc.lineage is not None:
            entry["lineage"] = doc.lineage
            entry["version"] = doc.version
        elif doc.version is not None:
            entry["version"] = doc.version
        if doc.version_label is not None:
            entry["version_label"] = doc.version_label
        if doc.effective_from is not None:
            entry["effective_from"] = doc.effective_from
        payload.append(entry)
    return json.dumps(payload, ensure_ascii=False, indent=2)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.corpus")
    sub = parser.add_subparsers(dest="command", required=True)
    dump = sub.add_parser("dump", help="print the parsed fixture corpus as JSON")
    dump.add_argument("corpus_dir")
    sha = sub.add_parser("sha256", help="print the corpus hash the TypeScript loader computes")
    sha.add_argument("corpus_dir")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")
    if args.command == "sha256":
        print(corpus_sha256(resolve_cli_path(args.corpus_dir)))
        return 0
    print(_dump(resolve_cli_path(args.corpus_dir)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
