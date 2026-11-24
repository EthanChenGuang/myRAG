import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from rag_eval.paths import resolve_cli_path

CORPUS_LANGUAGES = ("zh", "en", "it")
DEFAULT_CREATED_AT = "2025-01-15T00:00:00.000Z"
CHUNK_MARKER = "<!-- chunk -->"

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


def _js_trim(text: str) -> str:
    return text.strip(_JS_WS)


def _first_heading(text: str) -> str:
    for line in text.split("\n"):
        match = _HEADING_RE.match(line)
        if match:
            return match.group(1)
    return ""


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


def load_corpus(corpus_dir: Path) -> list[CorpusDocument]:
    corpus_dir = Path(corpus_dir)
    relpaths: list[str] = []
    for language in CORPUS_LANGUAGES:
        lang_dir = corpus_dir / language
        if not lang_dir.is_dir():
            continue
        for entry in lang_dir.iterdir():
            if entry.name.endswith(".md") and entry.is_file():
                relpaths.append(f"{language}/{entry.name}")
    relpaths.sort()

    documents: list[CorpusDocument] = []
    for relpath in relpaths:
        raw = (corpus_dir / relpath).read_bytes().decode("utf-8", errors="replace")
        lines = raw.replace("\r\n", "\n").split("\n")
        meta: dict = {}
        if _META_RE.match(_js_trim(lines[0])):
            meta = _parse_meta(lines.pop(0), relpath)
        language = relpath.split("/", 1)[0]
        filename = meta["filename"] if isinstance(meta.get("filename"), str) else relpath.rsplit("/", 1)[-1]

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

        documents.append(
            CorpusDocument(
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
                doc_type=meta["doc_type"] if isinstance(meta.get("doc_type"), str) else None,
            )
        )
    return documents


def _dump(corpus_dir: Path) -> str:
    payload = [
        {
            "relpath": doc.relpath,
            "filename": doc.filename,
            "language": doc.language,
            "chunks": [
                {"index": c.index, "section": c.section, "text": c.text, "stored": c.stored} for c in doc.chunks
            ],
        }
        for doc in load_corpus(corpus_dir)
    ]
    return json.dumps(payload, ensure_ascii=False, indent=2)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.corpus")
    sub = parser.add_subparsers(dest="command", required=True)
    dump = sub.add_parser("dump", help="print the parsed fixture corpus as JSON")
    dump.add_argument("corpus_dir")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")
    print(_dump(resolve_cli_path(args.corpus_dir)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
