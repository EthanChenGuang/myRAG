from dataclasses import dataclass
from pathlib import Path


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


def load_corpus(corpus_dir: Path) -> list[CorpusDocument]:
    raise NotImplementedError


def main(argv: list[str] | None = None) -> int:
    raise NotImplementedError
