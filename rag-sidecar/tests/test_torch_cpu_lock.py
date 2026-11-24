import tomllib
from pathlib import Path

LOCK = Path(__file__).resolve().parents[1] / "uv.lock"
CPU_INDEX = "https://download.pytorch.org/whl/cpu"


def _packages():
    return tomllib.loads(LOCK.read_text())["package"]


def test_torch_and_torchvision_resolve_from_the_cpu_index_only():
    for name in ("torch", "torchvision"):
        entries = [p for p in _packages() if p["name"] == name]
        assert entries, f"{name} is locked"
        for entry in entries:
            assert entry["source"].get("registry") == CPU_INDEX, f"{name} {entry['version']} comes from {entry['source']}"


def test_no_cuda_runtime_packages_are_locked():
    gpu = sorted({p["name"] for p in _packages() if p["name"].startswith(("nvidia-", "triton", "cuda-"))})
    assert gpu == []
