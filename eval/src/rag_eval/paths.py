from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def resolve_cli_path(p: str | Path) -> Path:
    path = Path(p)
    return path if path.is_absolute() else REPO_ROOT / path


def repo_relative(p: str | Path) -> str:
    """POSIX path relative to the repo root when inside it, so committed results do not depend on the checkout."""
    path = Path(p)
    try:
        return path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError:
        return str(path)
