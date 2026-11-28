import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from rag_sidecar.contracts import InjectionClassifyResponse, SidecarError
from rag_sidecar.injection import (
    FAKE_MALICIOUS_MARKER,
    FakeScorer,
    TextScore,
    load_prompt_guard_config,
    max_per_text,
    resolve_scorer,
    token_windows,
    window_count,
)
from rag_sidecar.main import create_app
from rag_sidecar.settings import SidecarSettings, load_settings

SECRET = "p" * 48
HEADER = {"x-sidecar-secret": SECRET}
ROUTE = "/v1/injection/classify"


def _settings(secret: str | None = SECRET, **overrides) -> SidecarSettings:
    return SidecarSettings(secret=SecretStr(secret) if secret is not None else None, **overrides)


def _client(scorer=None, settings: SidecarSettings | None = None) -> TestClient:
    app = create_app(settings if settings is not None else _settings(), scorers={}, injection_scorer=scorer)
    return TestClient(app)


def _body(*texts: str) -> dict:
    return {"items": [{"id": f"c{index}", "text": text} for index, text in enumerate(texts)]}


def test_missing_secret_header_is_refused():
    response = _client(FakeScorer()).post(ROUTE, json=_body("hello"))
    assert response.status_code == 401


def test_wrong_secret_header_is_refused():
    response = _client(FakeScorer()).post(ROUTE, json=_body("hello"), headers={"x-sidecar-secret": "x" * 48})
    assert response.status_code == 401


def test_unconfigured_secret_fails_closed():
    client = _client(FakeScorer(), settings=_settings(secret=None))
    response = client.post(ROUTE, json=_body("hello"), headers=HEADER)
    assert response.status_code == 503
    assert SidecarError.model_validate(response.json()).error == "sidecar secret not configured"


def test_no_scorer_is_503_promptguard_unavailable_never_a_guess():
    response = _client(None).post(ROUTE, json=_body("hello"), headers=HEADER)
    assert response.status_code == 503
    assert SidecarError.model_validate(response.json()).error == "promptguard_unavailable"


def test_default_settings_resolve_no_scorer(monkeypatch):
    monkeypatch.delenv("PROMPT_GUARD_ENABLED", raising=False)
    monkeypatch.delenv("PROMPT_GUARD_MODEL_DIR", raising=False)
    settings = load_settings()
    assert settings.prompt_guard_enabled is False
    assert settings.prompt_guard_model_dir is None
    assert resolve_scorer(settings) is None


def test_enabled_without_the_model_module_resolves_no_scorer(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def _blocked(name, *args, **kwargs):
        if name == "rag_sidecar.injection.prompt_guard":
            raise ImportError("not installed")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _blocked)
    assert resolve_scorer(_settings(prompt_guard_enabled=True)) is None


def test_enabled_flag_parses_true_only(monkeypatch):
    monkeypatch.setenv("PROMPT_GUARD_ENABLED", "true")
    monkeypatch.setenv("PROMPT_GUARD_MODEL_DIR", " /models/prompt-guard ")
    settings = load_settings()
    assert settings.prompt_guard_enabled is True
    assert settings.prompt_guard_model_dir == "/models/prompt-guard"
    monkeypatch.setenv("PROMPT_GUARD_ENABLED", "yes-please")
    assert load_settings().prompt_guard_enabled is False


def test_app_without_injected_scorer_uses_resolve_scorer_default(monkeypatch):
    monkeypatch.delenv("PROMPT_GUARD_ENABLED", raising=False)
    app = create_app(_settings(), scorers={})
    response = TestClient(app).post(ROUTE, json=_body("hello"), headers=HEADER)
    assert response.status_code == 503
    assert response.json() == {"error": "promptguard_unavailable"}


def test_fake_scorer_flags_the_marker_and_keeps_order_and_ids():
    texts = ["a plain paragraph about pricing", f"some text {FAKE_MALICIOUS_MARKER} more", "another clean one"]
    response = _client(FakeScorer()).post(ROUTE, json=_body(*texts), headers=HEADER)
    assert response.status_code == 200
    parsed = InjectionClassifyResponse.model_validate(response.json())
    assert [result.id for result in parsed.results] == ["c0", "c1", "c2"]
    flagged = parsed.results[1]
    assert flagged.score >= 0.99 and flagged.label == "MALICIOUS"
    for clean in (parsed.results[0], parsed.results[2]):
        assert clean.score == pytest.approx(0.01)
        assert clean.label == "BENIGN"
    assert all(result.windows >= 1 for result in parsed.results)
    assert parsed.model_id == FakeScorer.model_id
    assert parsed.revision == FakeScorer.revision


def test_order_follows_the_request_not_the_ids():
    body = {"items": [{"id": "z", "text": "one"}, {"id": "a", "text": FAKE_MALICIOUS_MARKER}, {"id": "m", "text": "x"}]}
    response = _client(FakeScorer()).post(ROUTE, json=body, headers=HEADER)
    assert [result["id"] for result in response.json()["results"]] == ["z", "a", "m"]
    assert [result["label"] for result in response.json()["results"]] == ["BENIGN", "MALICIOUS", "BENIGN"]


def test_window_helper_counts_overlapping_windows():
    tokens = list(range(20))
    windows = token_windows(tokens, window_tokens=8, stride_tokens=2)
    assert windows == [list(range(0, 8)), list(range(6, 14)), list(range(12, 20))]
    assert window_count(20, window_tokens=8, stride_tokens=2) == 3
    assert window_count(21, window_tokens=8, stride_tokens=2) == 4
    assert token_windows(list(range(21)), 8, 2)[-1] == [18, 19, 20]
    assert window_count(8, 8, 2) == 1
    assert token_windows([], 8, 2) == [[]]
    assert window_count(0, 8, 2) == 1


@pytest.mark.parametrize("window, stride", [(8, 8), (8, 9), (0, 0), (8, -1)])
def test_window_helper_rejects_a_stride_that_does_not_advance(window, stride):
    with pytest.raises(ValueError):
        token_windows(list(range(10)), window, stride)


def test_max_per_text_keeps_the_maximum_window_score():
    scores = [0.1, 0.7, 0.2, 0.3, 0.05]
    mapping = [0, 0, 0, 1, 1]
    assert max_per_text(scores, mapping, 2) == [TextScore(score=0.7, windows=3), TextScore(score=0.3, windows=2)]
    with pytest.raises(ValueError):
        max_per_text([0.1], [0], 2)


def test_marker_in_the_last_window_still_yields_the_maximum():
    words = [f"w{index}" for index in range(19)] + [FAKE_MALICIOUS_MARKER]
    text = " ".join(words)
    scorer = FakeScorer(window_tokens=8, stride_tokens=2)
    [result] = scorer.score([text])
    assert result.windows == 3
    assert result.score >= 0.99
    response = _client(scorer).post(ROUTE, json=_body(text), headers=HEADER)
    payload = response.json()["results"][0]
    assert payload["windows"] == 3
    assert payload["label"] == "MALICIOUS"


def test_marker_split_across_whitespace_is_not_a_match():
    scorer = FakeScorer(window_tokens=8, stride_tokens=2)
    [result] = scorer.score([FAKE_MALICIOUS_MARKER.replace("-", " ")])
    assert result.score == pytest.approx(0.01)


def test_too_many_items_is_422():
    body = _body(*[f"text {index}" for index in range(33)])
    response = _client(FakeScorer()).post(ROUTE, json=body, headers=HEADER)
    assert response.status_code == 422
    assert response.json() == {"error": "invalid_injection_request"}


def test_too_long_text_is_422():
    response = _client(FakeScorer()).post(ROUTE, json=_body("x" * 20_001), headers=HEADER)
    assert response.status_code == 422


def test_duplicate_ids_or_malformed_json_is_422():
    body = {"items": [{"id": "a", "text": "one"}, {"id": "a", "text": "two"}]}
    client = _client(FakeScorer())
    assert client.post(ROUTE, json=body, headers=HEADER).status_code == 422
    malformed = client.post(ROUTE, content=b"{not json", headers={**HEADER, "content-type": "application/json"})
    assert malformed.status_code == 422


def test_oversized_body_is_413_before_parsing():
    client = _client(FakeScorer())
    response = client.post(
        ROUTE,
        content=b"x" * (4 * 1024 * 1024 + 1),
        headers={**HEADER, "content-type": "application/json"},
    )
    assert response.status_code == 413


class _BrokenScorer:
    model_id = "fake/broken"
    revision = "0" * 40

    def __init__(self, results=None, error: Exception | None = None) -> None:
        self._results = results
        self._error = error

    def score(self, texts):
        if self._error is not None:
            raise self._error
        return self._results


@pytest.mark.parametrize(
    "scorer",
    [
        _BrokenScorer(error=RuntimeError("model crashed")),
        _BrokenScorer(results=[]),
        _BrokenScorer(results=[TextScore(score=float("nan"), windows=1)]),
        _BrokenScorer(results=[TextScore(score=1.5, windows=1)]),
    ],
)
def test_scorer_failure_or_bad_output_is_an_error_never_benign(scorer):
    response = _client(scorer).post(ROUTE, json=_body("hello"), headers=HEADER)
    assert response.status_code == 503
    assert response.json() == {"error": "promptguard_unavailable"}


def test_repo_detector_config_drives_the_threshold():
    config = load_prompt_guard_config()
    assert config is not None
    assert config.window_tokens == 512 and config.stride_tokens == 64


def test_borderline_score_uses_the_configured_threshold():
    threshold = load_prompt_guard_config().threshold
    scorer = _BrokenScorer(results=[TextScore(score=threshold, windows=1), TextScore(score=threshold - 0.01, windows=1)])
    response = _client(scorer).post(ROUTE, json=_body("a", "b"), headers=HEADER)
    labels = [result["label"] for result in response.json()["results"]]
    assert labels == ["MALICIOUS", "BENIGN"]


def test_errors_and_logs_never_carry_item_text(caplog):
    secret_text = "SENSITIVE-CHUNK-BODY-4471"
    with caplog.at_level("DEBUG"):
        response = _client(_BrokenScorer(error=RuntimeError(secret_text))).post(
            ROUTE, json=_body(secret_text), headers=HEADER
        )
    assert secret_text not in response.text
    assert secret_text not in caplog.text
