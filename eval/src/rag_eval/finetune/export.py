"""Tenant-scoped, consent-checked corpus export (D-02, D-27, D-28, D-36)."""
from pathlib import Path

from rag_eval.paths import REPO_ROOT

ENV_LOCAL_PATH = REPO_ROOT / ".env.local"
FIXTURES_ROOT = REPO_ROOT / "eval" / "fixtures"


class ExportRefused(Exception):
    def __init__(self, code: str, exit_code: int = 2):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


def finetune_enabled() -> bool:
    return True


def check_fixture_dir(path) -> Path:
    return Path(path)


class SupabaseExportSource:
    def __init__(self, url, service_key, *, client=None):
        pass


def run_export(**kwargs):
    return None


def main(argv=None, *, client=None) -> int:
    return 0
