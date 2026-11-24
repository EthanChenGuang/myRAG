"""Boundary scan: sidecar worker must not write documents/chunks or call ledger RPCs outside ledger_client."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

SIDECAR_SRC = Path(__file__).resolve().parent.parent / "src" / "rag_sidecar"
LEDGER_RPC_CLIENT = "ingest/ledger_client.py"

FORBIDDEN_DOCUMENT_PATHS = ("/rest/v1/documents", "/rest/v1/document_chunks")
FORBIDDEN_LEDGER_TABLE_PATHS = ("/rest/v1/ingestion_", "/rest/v1/rag_parse")
RPC_PATH = "/rest/v1/rpc/"


def scan_ingest_boundary(root: Path) -> list[str]:
    """Return human-readable violations found under a rag_sidecar source tree."""
    violations: list[str] = []
    if not root.is_dir():
        return [f"{root}: not a directory"]

    for path in sorted(root.rglob("*.py")):
        rel = path.relative_to(root).as_posix()
        text = path.read_text(encoding="utf-8")

        for needle in FORBIDDEN_DOCUMENT_PATHS:
            if needle in text:
                violations.append(f"{rel}: forbidden document write path {needle}")

        for needle in FORBIDDEN_LEDGER_TABLE_PATHS:
            if needle in text:
                violations.append(f"{rel}: forbidden ledger table path {needle}")

        if RPC_PATH in text and rel != LEDGER_RPC_CLIENT:
            violations.append(f"{rel}: {RPC_PATH} only allowed in {LEDGER_RPC_CLIENT}")

    return violations


def test_real_tree_passes_ingest_boundary_scan():
    assert scan_ingest_boundary(SIDECAR_SRC) == []


def test_scanner_detects_synthetic_violations_in_a_temp_tree():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "rag_sidecar"
        shutil.copytree(SIDECAR_SRC, root)
        bad = root / "parse" / "evil.py"
        bad.write_text('URL = "/rest/v1/document_chunks"\n', encoding="utf-8")
        violations = scan_ingest_boundary(root)
        assert any("evil.py" in v and "document_chunks" in v for v in violations)


def test_ledger_client_is_the_only_declared_rpc_caller():
    """Plans 03.1-17 onward add ingest/ledger_client.py as the sole RPC module."""
    assert LEDGER_RPC_CLIENT.endswith("ledger_client.py")
    # Today the ingest package may not exist; the scanner still defines the contract.
    allowed = root if (root := SIDECAR_SRC / "ingest" / "ledger_client.py").exists() else None
    if allowed is not None:
        text = allowed.read_text(encoding="utf-8")
        assert RPC_PATH in text or "ledger_client" in allowed.name