import copy
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts import (
    InjectionClassifyRequest,
    InjectionClassifyResponse,
    InjectionDetectorConfig,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / "config" / "rag" / "injection-detectors.json"


def _items(count: int) -> list[dict[str, str]]:
    return [{"id": f"chunk-{index:03d}", "text": f"Synthetic chunk text {index}."} for index in range(count)]


def _result(**overrides) -> dict:
    value = {"id": "chunk-000", "score": 0.12, "label": "BENIGN", "windows": 1}
    value.update(overrides)
    return value


def _response(results: list[dict]) -> dict:
    return {
        "model_id": "meta-llama/Llama-Prompt-Guard-2-86M",
        "revision": "a8ded8e697ce7c355e395a0df51f94adb4a2fd27",
        "results": results,
    }


def _config() -> dict:
    return {
        "schema_version": 1,
        "version": "2026-11-24.1",
        "prompt_guard": {
            "model_id": "meta-llama/Llama-Prompt-Guard-2-86M",
            "revision": "a8ded8e697ce7c355e395a0df51f94adb4a2fd27",
            "threshold": 0.5,
            "languages": ["en", "it"],
            "window_tokens": 512,
            "stride_tokens": 64,
            "max_items": 16,
            "inline_profiles": ["eval"],
            "warm_profiles": ["chat", "embed"],
        },
        "lakera": {
            "detector_types": ["prompt_attack"],
            "min_level": None,
            "concurrency": 4,
            "max_chars": 20000,
            "profiles": ["chat", "embed", "eval"],
        },
        "cache": {"max_entries": 5000},
        "inner_reserve_ms": 25,
    }


def _with(path: tuple[str, ...], value) -> dict:
    config = copy.deepcopy(_config())
    node = config
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    return config


def test_request_accepts_one_and_thirty_two_items():
    assert len(InjectionClassifyRequest.model_validate({"items": _items(1)}).items) == 1
    assert len(InjectionClassifyRequest.model_validate({"items": _items(32)}).items) == 32


@pytest.mark.parametrize(
    "payload",
    [
        {"items": []},
        {"items": _items(33)},
        {"items": [{"id": "chunk-000", "text": "a"}, {"id": "chunk-000", "text": "b"}]},
        {"items": [{"id": "chunk-000", "text": ""}]},
        {"items": [{"id": "chunk-000", "text": "x" * 20001}]},
        {"items": [{"id": "", "text": "a"}]},
        {"items": [{"id": "x" * 65, "text": "a"}]},
        {"items": _items(1), "extra": True},
        {"items": [{"id": "chunk-000", "text": "a", "tenant": "t1"}]},
    ],
    ids=["zero", "thirty_three", "duplicate_id", "empty_text", "text_too_long", "empty_id", "id_too_long", "extra_key", "item_extra_key"],
)
def test_request_rejects_invalid_shapes(payload):
    with pytest.raises(ValidationError):
        InjectionClassifyRequest.model_validate(payload)


def test_request_accepts_boundary_lengths():
    request = InjectionClassifyRequest.model_validate({"items": [{"id": "x" * 64, "text": "y" * 20000}]})
    assert len(request.items[0].text) == 20000


def test_request_is_frozen():
    request = InjectionClassifyRequest.model_validate({"items": _items(1)})
    with pytest.raises(ValidationError):
        request.items = []


def test_response_accepts_valid_results():
    response = InjectionClassifyResponse.model_validate(
        _response([_result(), _result(id="chunk-001", score=0.97, label="MALICIOUS", windows=3)])
    )
    assert [result.label for result in response.results] == ["BENIGN", "MALICIOUS"]


@pytest.mark.parametrize(
    "result",
    [
        _result(score=1.2),
        _result(score=-0.1),
        _result(label="INJECTION"),
        _result(windows=0),
        _result(extra=1),
    ],
    ids=["score_above_one", "score_below_zero", "unknown_label", "zero_windows", "extra_key"],
)
def test_response_rejects_invalid_results(result):
    with pytest.raises(ValidationError):
        InjectionClassifyResponse.model_validate(_response([result]))


def test_response_rejects_duplicate_result_ids_and_missing_model_fields():
    with pytest.raises(ValidationError):
        InjectionClassifyResponse.model_validate(_response([_result(), _result()]))
    with pytest.raises(ValidationError):
        InjectionClassifyResponse.model_validate({**_response([_result()]), "model_id": ""})
    with pytest.raises(ValidationError):
        InjectionClassifyResponse.model_validate({**_response([_result()]), "revision": ""})


def test_detector_config_accepts_the_reference_shape():
    config = InjectionDetectorConfig.model_validate(_config())
    assert config.lakera.min_level is None
    assert InjectionDetectorConfig.model_validate(_with(("lakera", "min_level"), "l2_very_likely")).lakera.min_level == "l2_very_likely"


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("lakera", "detector_types"), []),
        (("lakera", "detector_types"), ["prompt_attack", "prompt_attack"]),
        (("lakera", "concurrency"), 9),
        (("lakera", "concurrency"), 0),
        (("lakera", "min_level"), "no_level"),
        (("lakera", "min_level"), "l6_never"),
        (("lakera", "max_chars"), 0),
        (("prompt_guard", "threshold"), 1.01),
        (("prompt_guard", "threshold"), -0.01),
        (("prompt_guard", "stride_tokens"), 512),
        (("prompt_guard", "stride_tokens"), 600),
        (("prompt_guard", "window_tokens"), 1024),
        (("prompt_guard", "max_items"), 33),
        (("prompt_guard", "languages"), ["en", "zh"]),
        (("prompt_guard", "languages"), []),
        (("prompt_guard", "languages"), ["en", "en"]),
        (("prompt_guard", "revision"), "main"),
        (("prompt_guard", "inline_profiles"), ["whatsapp"]),
        (("prompt_guard", "warm_profiles"), ["chat", "unknown"]),
        (("prompt_guard", "inline_profiles"), ["voice"]),
        (("prompt_guard", "warm_profiles"), ["chat", "voice"]),
        (("prompt_guard", "inline_profiles"), ["media"]),
        (("prompt_guard", "inline_profiles"), ["eval", "chat"]),
        (("prompt_guard", "warm_profiles"), ["chat", "chat"]),
        (("lakera", "profiles"), ["chat", "voice"]),
        (("lakera", "profiles"), ["media"]),
        (("lakera", "profiles"), ["nope"]),
        (("cache", "max_entries"), 0),
        (("inner_reserve_ms",), -1),
        (("schema_version",), 2),
        (("version",), "latest"),
        (("unexpected",), True),
    ],
)
def test_detector_config_rejects_invalid_values(path, value):
    with pytest.raises(ValidationError):
        InjectionDetectorConfig.model_validate(_with(path, value))


def test_committed_config_file_validates_with_the_decided_values():
    assert CONFIG_PATH.exists(), f"missing {CONFIG_PATH}"
    config = InjectionDetectorConfig.model_validate(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    assert config.version == "2026-11-24.1"
    assert config.prompt_guard.languages == ["en", "it"]
    assert config.prompt_guard.inline_profiles == ["eval"]
    assert config.prompt_guard.warm_profiles == ["chat", "embed"]
    assert config.prompt_guard.window_tokens == 512
    assert config.prompt_guard.stride_tokens == 64
    assert config.prompt_guard.revision == "a8ded8e697ce7c355e395a0df51f94adb4a2fd27"
    assert config.lakera.detector_types == ["prompt_attack"]
    assert config.lakera.min_level is None
    assert config.lakera.concurrency == 4
    assert "voice" not in config.lakera.profiles
    assert config.cache.max_entries == 5000
    assert config.inner_reserve_ms == 25
