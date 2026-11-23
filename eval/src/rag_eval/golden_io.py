from pathlib import Path

from rag_sidecar.contracts.golden import GoldenItem


def load_golden(path: Path) -> list[GoldenItem]:
    raise NotImplementedError


def write_golden(path: Path, items: list[GoldenItem]) -> None:
    raise NotImplementedError


def golden_sha256(path: Path) -> str:
    raise NotImplementedError
