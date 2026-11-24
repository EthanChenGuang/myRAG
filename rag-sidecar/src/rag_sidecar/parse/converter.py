import importlib
import importlib.util
import os
import re
import sys
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
    """Turns one uploaded file into a ParseResult, writing every artifact it lists into out_dir.

    Instances are pickled into each pool worker (spawn), so they must be picklable and cheap to
    construct; models and pipelines are built lazily on the first convert call inside the worker.
    Raise ConversionError(error_class) for a classified failure; any other exception is reported
    by its snake_case class name and its message is dropped.
    """

    def convert(self, input_path: Path, request: ParseJobRequest, out_dir: Path) -> ParseResult: ...


_ERROR_CLASS = re.compile(r"[a-z][a-z0-9_]{0,63}")
_ADAPTER_MODULE = "rag_sidecar.parse.docling_adapter"


def error_class_of(error: BaseException) -> str:
    declared = getattr(error, "error_class", None)
    if isinstance(declared, str) and _ERROR_CLASS.fullmatch(declared):
        return declared
    name = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", type(error).__name__)
    name = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name).lower()
    name = re.sub(r"[^a-z0-9_]", "_", name)
    if not name or not name[0].isalpha():
        name = f"error_{name}"
    return name[:64]


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
            raise self.raises(self.message) if self.message else self.raises()
        for name, payload in {**self.artifacts, **self.unlisted}.items():
            (out_dir / name).write_bytes(payload)
        base = self.result if self.result is not None else stub_result()
        return base.model_copy(update={"artifacts": sorted(self.artifacts)}) if self.artifacts else base


def _importable(name: str) -> bool:
    if name in sys.modules:
        return True
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def docling_available() -> bool:
    return _importable("docling") and _importable(_ADAPTER_MODULE)


class LazyDoclingConverter:
    """Defers the heavy Docling import to the first convert call, which runs in a pool worker."""

    def __init__(self) -> None:
        self._converter: Converter | None = None

    def __getstate__(self) -> dict[str, object]:
        return {}

    def __setstate__(self, _state: dict[str, object]) -> None:
        self._converter = None

    def convert(self, input_path: Path, request: ParseJobRequest, out_dir: Path) -> ParseResult:
        if self._converter is None:
            self._converter = importlib.import_module(_ADAPTER_MODULE).DoclingConverter()
        return self._converter.convert(input_path, request, out_dir)


def default_converter() -> Converter | None:
    return LazyDoclingConverter() if docling_available() else None
