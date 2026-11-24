import importlib.util
import re
import tomllib
from pathlib import Path

SIDECAR_DIR = Path(__file__).resolve().parent.parent
PYPROJECT = SIDECAR_DIR / "pyproject.toml"
UV_LOCK = SIDECAR_DIR / "uv.lock"

PINNED_LOCK_VERSIONS = {
    "pdfplumber": "0.11.11",
    "pdfminer-six": "20260107",
    "ray": "2.60.1",
}
PYPI_REGISTRY = "https://pypi.org/simple"
FORBIDDEN_LOCK_NAMES = {"pymupdf", "fitz"}
PINNED_EXTRAS: dict[str, set[str]] = {
    "preflight": {"pypdfium2", "pdfplumber"},
    "docling": {"pypdfium2", "pdfplumber"},
    "ray": {"ray"},
}


def _load_pyproject() -> dict:
    return tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))


def _load_lock() -> dict:
    return tomllib.loads(UV_LOCK.read_text(encoding="utf-8"))


def _lock_index(lock: dict) -> dict[str, dict]:
    return {entry["name"]: entry for entry in lock["package"]}


def _registry_source(entry: dict) -> bool:
    source = entry.get("source")
    return isinstance(source, dict) and source.get("registry") == PYPI_REGISTRY


def _sha256_hashes_only(artifacts: list[dict]) -> None:
    for artifact in artifacts:
        digest = artifact.get("hash", "")
        assert digest.startswith("sha256:"), artifact


def _package_artifacts(entry: dict) -> list[dict]:
    items: list[dict] = []
    if "sdist" in entry:
        items.append(entry["sdist"])
    items.extend(entry.get("wheels", []))
    return items


def _named_requirements(extra: list[str], names: set[str]) -> list[str]:
    out: list[str] = []
    for req in extra:
        head = re.split(r"[<>=!;\[]", req, maxsplit=1)[0].strip().lower()
        if head in names or any(name in req.lower() for name in names):
            out.append(req)
    return out


def test_default_environment_has_no_ray_module():
    assert importlib.util.find_spec("ray") is None


def test_lock_excludes_pymupdf_and_fitz():
    names = {entry["name"].lower() for entry in _load_lock()["package"]}
    assert FORBIDDEN_LOCK_NAMES.isdisjoint(names), FORBIDDEN_LOCK_NAMES & names


def test_ray_extra_is_optional_with_exact_pin():
    optional = _load_pyproject()["project"]["optional-dependencies"]
    assert optional["ray"] == ["ray[data]==2.60.1"]
    sidecar_meta = next(entry for entry in _load_lock()["package"] if entry["name"] == "rag-sidecar")
    provides = set(sidecar_meta.get("metadata", {}).get("provides-extras", []))
    assert "ray" in provides


def test_pinned_packages_in_lock_use_pypi_registry_versions_and_sha256():
    index = _lock_index(_load_lock())
    for name, version in PINNED_LOCK_VERSIONS.items():
        entry = index[name]
        assert entry["version"] == version, (name, entry["version"])
        assert _registry_source(entry), entry.get("source")
        artifacts = _package_artifacts(entry)
        assert artifacts, name
        _sha256_hashes_only(artifacts)


def test_preflight_docling_and_ray_extras_use_exact_pins():
    optional = _load_pyproject()["project"]["optional-dependencies"]
    for extra, names in PINNED_EXTRAS.items():
        reqs = _named_requirements(optional[extra], names)
        assert reqs, (extra, names)
        for req in reqs:
            assert "==" in req, (extra, req)