import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from rag_sidecar.contracts import ParseChunk, ParseJobRequest, ParseResult


class ConversionError(Exception):
    def __init__(self, error_class: str) -> None:
        super().__init__(error_class)
        self.error_class = error_class


class PageCapExceeded(ConversionError):
    def __init__(self) -> None:
        super().__init__("page_cap")


class Converter(Protocol):
    def convert(self, input_path: Path, request: ParseJobRequest, out_dir: Path) -> ParseResult: ...


def stub_result(page_count: int = 1, artifacts: list[str] | None = None) -> ParseResult:
    return ParseResult(
        markdown="# Stub\n\nbody",
        chunks=[
            ParseChunk(text="body", contextualized_text="Stub\nbody", headings=["Stub"], pages=[1], is_table=False)
        ],
        pictures=[],
        page_count=page_count,
        language="en",
        parser="docling",
        parser_version="stub",
        artifacts=list(artifacts or []),
    )


@dataclass(frozen=True)
class StubConverter:
    result: ParseResult | None = None
    delay_seconds: float = 0.0
    gate_path: str | None = None
    gate_timeout_seconds: float = 30.0
    raises: type[BaseException] | None = None
    error_class: str | None = None
    message: str = "stub failure"
    crash_marker: bytes | None = None
    artifacts: dict[str, bytes] = field(default_factory=dict)
    unlisted: dict[str, bytes] = field(default_factory=dict)

    def convert(self, input_path: Path, request: ParseJobRequest, out_dir: Path) -> ParseResult:
        if self.crash_marker is not None and input_path.read_bytes().startswith(self.crash_marker):
            os._exit(17)
        if self.gate_path is not None:
            deadline = time.monotonic() + self.gate_timeout_seconds
            while not Path(self.gate_path).exists() and time.monotonic() < deadline:
                time.sleep(0.01)
        if self.delay_seconds > 0:
            time.sleep(self.delay_seconds)
        if self.error_class is not None:
            raise ConversionError(self.error_class)
        if self.raises is not None:
            raise self.raises(self.message)
        for name, payload in {**self.artifacts, **self.unlisted}.items():
            (out_dir / name).write_bytes(payload)
        base = self.result if self.result is not None else stub_result()
        return base.model_copy(update={"artifacts": sorted(self.artifacts)}) if self.artifacts else base


def docling_available() -> bool:
    return False


def default_converter() -> Converter | None:
    return None
