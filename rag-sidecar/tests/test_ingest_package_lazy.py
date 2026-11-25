"""The worker path must not need the Docling stack: importing a client module leaves docling_core unloaded."""

from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"


def _run(code: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-I", "-c", textwrap.dedent(code)],
        capture_output=True,
        text=True,
        env={"PYTHONPATH": str(SRC)},
        check=False,
    )


def test_importing_the_ledger_client_does_not_load_docling_core():
    result = _run(
        """
        import sys
        import rag_sidecar.ingest.ledger_client  # noqa: F401
        assert "docling_core" not in sys.modules, "docling_core was imported by the package init"
        print("ok")
        """
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_package_exports_resolve_on_first_access():
    result = _run(
        """
        import rag_sidecar.ingest as ingest
        assert callable(ingest.options_hash)
        assert callable(ingest.merged_options_hash)
        assert "options_hash" in ingest.__all__
        print("ok")
        """
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"
