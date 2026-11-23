from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def resolve_cli_path(p: str | Path) -> Path:
    path = Path(p)
    return path if path.is_absolute() else REPO_ROOT / path
