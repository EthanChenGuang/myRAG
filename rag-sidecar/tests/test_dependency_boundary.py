import importlib.util
import re
import shutil
import subprocess
import tomllib
from pathlib import Path

import pytest

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
    "hidden-text": {"pypdfium2", "pdfplumber", "python-docx", "lxml", "defusedxml"},
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

HHEM_PINS = {"torch": "2.15.0", "transformers": "5.23.0"}
PYTORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu"


def _sidecar_lock_entry(lock: dict) -> dict:
    return next(entry for entry in lock["package"] if entry["name"] == "rag-sidecar")


def test_hhem_extra_is_optional_with_exact_pins():
    optional = _load_pyproject()["project"]["optional-dependencies"]
    assert "hhem" in optional
    assert sorted(optional["hhem"]) == sorted(f"{name}=={version}" for name, version in HHEM_PINS.items())
    dependencies = _load_pyproject()["project"]["dependencies"]
    assert not _named_requirements(dependencies, set(HHEM_PINS))


def test_hhem_extra_excludes_sentencepiece():
    optional = _load_pyproject()["project"]["optional-dependencies"]
    assert not any("sentencepiece" in req.lower() for req in optional.get("hhem", []))
    names = {entry["name"].lower() for entry in _load_lock()["package"]}
    assert "sentencepiece" not in names


def test_hhem_torch_resolves_from_the_pytorch_cpu_index():
    pyproject = _load_pyproject()
    sources = pyproject["tool"]["uv"]["sources"]["torch"]
    assert sources == [{"index": "pytorch-cpu"}]
    index = next(i for i in pyproject["tool"]["uv"]["index"] if i["name"] == "pytorch-cpu")
    assert index["url"] == PYTORCH_CPU_INDEX and index["explicit"] is True


def test_hhem_extra_is_locked_with_sha256_hashes():
    lock = _load_lock()
    sidecar = _sidecar_lock_entry(lock)
    assert "hhem" in sidecar.get("metadata", {}).get("provides-extras", [])
    hhem_deps = sidecar.get("optional-dependencies", {}).get("hhem", [])
    assert {dep["name"] for dep in hhem_deps} == set(HHEM_PINS)
    torch_entries = [entry for entry in lock["package"] if entry["name"] == "torch"]
    assert torch_entries
    for entry in torch_entries:
        assert entry["version"].split("+")[0] == HHEM_PINS["torch"], entry["version"]
        assert entry["source"] == {"registry": PYTORCH_CPU_INDEX}, entry["source"]
        artifacts = _package_artifacts(entry)
        assert artifacts
        _sha256_hashes_only(artifacts)
    transformers = _lock_index(lock)["transformers"]
    assert transformers["version"] == HHEM_PINS["transformers"]
    assert _registry_source(transformers), transformers.get("source")
    assert "sdist" in transformers
    _sha256_hashes_only(_package_artifacts(transformers))


def test_default_environment_has_no_torch_or_transformers():
    assert importlib.util.find_spec("torch") is None
    assert importlib.util.find_spec("transformers") is None

CACHE_PINS = {"redisvl": "0.32.0", "redis": "8.1.0"}
CACHE_TRANSITIVES = {"jsonpath-ng", "ml-dtypes", "python-ulid", "tenacity"}
CACHE_CUTOFF = "2026-11-19T00:00:00Z"


def _uv_export(*extra_args: str) -> set[str]:
    result = subprocess.run(
        ["uv", "export", "--frozen", "--no-hashes", "--no-header", "--no-emit-project", *extra_args],
        cwd=SIDECAR_DIR,
        capture_output=True,
        text=True,
        check=True,
    )
    lines = (line.split(";", 1)[0].strip() for line in result.stdout.splitlines())
    return {line.lower() for line in lines if line and not line.startswith(("#", "-"))}


def test_cache_extra_is_optional_with_exact_pins():
    pyproject = _load_pyproject()
    optional = pyproject["project"]["optional-dependencies"]
    assert sorted(optional["cache"]) == sorted(f"{name}=={version}" for name, version in CACHE_PINS.items())
    assert not _named_requirements(pyproject["project"]["dependencies"], set(CACHE_PINS))
    for extra, reqs in optional.items():
        if extra != "cache":
            assert not _named_requirements(reqs, set(CACHE_PINS)), extra


def test_cache_packages_have_exclude_newer_cutoffs():
    per_package = _load_pyproject()["tool"]["uv"]["exclude-newer-package"]
    for name in (*CACHE_PINS, *CACHE_TRANSITIVES):
        assert per_package.get(name) == CACHE_CUTOFF, (name, per_package.get(name))


def test_cache_extra_is_locked_from_pypi_with_sha256_hashes():
    lock = _load_lock()
    sidecar = _sidecar_lock_entry(lock)
    assert "cache" in sidecar.get("metadata", {}).get("provides-extras", [])
    cache_deps = sidecar.get("optional-dependencies", {}).get("cache", [])
    assert {dep["name"] for dep in cache_deps} == set(CACHE_PINS)
    index = _lock_index(lock)
    for name, version in CACHE_PINS.items():
        assert index[name]["version"] == version, (name, index[name]["version"])
    for name in (*CACHE_PINS, *CACHE_TRANSITIVES):
        entry = index[name]
        assert _registry_source(entry), (name, entry.get("source"))
        artifacts = _package_artifacts(entry)
        assert artifacts, name
        _sha256_hashes_only(artifacts)
        for artifact in artifacts:
            uploaded = artifact.get("upload-time", "")
            assert uploaded and uploaded <= CACHE_CUTOFF, (name, uploaded)


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv is not installed")
def test_default_export_excludes_the_cache_extra():
    default = _uv_export()
    names = {req.split("==", 1)[0] for req in default}
    assert names.isdisjoint({*CACHE_PINS, *CACHE_TRANSITIVES}), names & {*CACHE_PINS, *CACHE_TRANSITIVES}


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv is not installed")
def test_cache_export_lists_the_pinned_versions():
    with_cache = _uv_export("--extra", "cache")
    for name, version in CACHE_PINS.items():
        assert f"{name}=={version}" in with_cache, name
