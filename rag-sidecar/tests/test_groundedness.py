import asyncio
import os
import subprocess
import sys
import threading

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from rag_sidecar.contracts import GroundednessResult, SidecarError, SidecarReady
from rag_sidecar.groundedness import (
    LOCAL_SCORER,
    VECTARA_SCORER,
    ScorerBusy,
    ScorerUnavailable,
    StubScorer,
    build_scorers,
)
from rag_sidecar.groundedness.local_hhem import HHEM_MODEL_ID, LocalHhemScorer
from rag_sidecar.main import create_app
from rag_sidecar.settings import SidecarSettings

SECRET = "g" * 48
HEADER = {"x-sidecar-secret": SECRET}
PLACEHOLDER_KEY = "vectara-placeholder-key"


def _settings(secret: str | None = SECRET) -> SidecarSettings:
    return SidecarSettings(secret=SecretStr(secret) if secret is not None else None)


def _stubs(
    *,
    vectara: StubScorer | None = None,
    local: StubScorer | None = None,
) -> dict[str, StubScorer]:
    return {
        VECTARA_SCORER: vectara if vectara is not None else StubScorer(VECTARA_SCORER, score=0.83),
        LOCAL_SCORER: local if local is not None else StubScorer(LOCAL_SCORER, score=0.61),
    }


def _body(language: str = "en", allow_vectara: bool = True, **overrides) -> dict:
    body = {
        "request_id": "req-1",
        "language": language,
        "premise_texts": ["The sky is blue.", "Grass is green."],
        "hypothesis": "The sky is blue.",
        "allow_vectara": allow_vectara,
    }
    body.update(overrides)
    return body


def _post(scorers, body, headers=HEADER, settings=None):
    app = create_app(settings if settings is not None else _settings(), scorers=scorers)
    return TestClient(app).post("/v1/groundedness", json=body, headers=headers)


def _result(response) -> GroundednessResult:
    assert response.status_code == 200, response.text
    return GroundednessResult.model_validate(response.json())


def test_en_with_vectara_allowed_uses_vectara():
    scorers = _stubs()
    result = _result(_post(scorers, _body("en", True)))
    assert result.status == "scored"
    assert result.scorer == "hhem_2_3_vectara"
    assert result.score == pytest.approx(0.83)
    assert result.latency_ms >= 0
    assert scorers[VECTARA_SCORER].calls == 1
    assert scorers[LOCAL_SCORER].calls == 0


def test_en_without_vectara_allowed_uses_local():
    scorers = _stubs()
    result = _result(_post(scorers, _body("en", False)))
    assert (result.status, result.scorer) == ("scored", "hhem_2_1_open")
    assert result.score == pytest.approx(0.61)
    assert scorers[VECTARA_SCORER].calls == 0
    assert scorers[LOCAL_SCORER].calls == 1


def test_en_with_vectara_allowed_but_no_key_uses_local():
    scorers = {LOCAL_SCORER: StubScorer(LOCAL_SCORER, score=0.4)}
    result = _result(_post(scorers, _body("en", True)))
    assert (result.status, result.scorer) == ("scored", "hhem_2_1_open")


def test_zh_hans_with_vectara_allowed_uses_vectara():
    scorers = _stubs()
    result = _result(_post(scorers, _body("zh-Hans", True)))
    assert (result.status, result.scorer) == ("scored", "hhem_2_3_vectara")
    assert scorers[LOCAL_SCORER].calls == 0


def test_zh_hans_without_vectara_allowed_is_scorer_unavailable():
    scorers = _stubs()
    result = _result(_post(scorers, _body("zh-Hans", False)))
    assert (result.status, result.scorer, result.reason) == ("not_checked", "none", "scorer_unavailable")
    assert result.score is None
    assert scorers[VECTARA_SCORER].calls == 0
    assert scorers[LOCAL_SCORER].calls == 0


def test_zh_hans_without_vectara_key_is_scorer_unavailable():
    scorers = {LOCAL_SCORER: StubScorer(LOCAL_SCORER)}
    result = _result(_post(scorers, _body("zh-Hans", True)))
    assert (result.status, result.reason) == ("not_checked", "scorer_unavailable")
    assert scorers[LOCAL_SCORER].calls == 0


@pytest.mark.parametrize("language", ["it", "zh-Hant", "unknown", "de", "mixed", "zh"])
def test_unsupported_languages_never_call_a_scorer(language):
    scorers = _stubs()
    result = _result(_post(scorers, _body(language, True)))
    assert (result.status, result.scorer, result.reason) == ("not_checked", "none", "unsupported_language")
    assert scorers[VECTARA_SCORER].calls == 0
    assert scorers[LOCAL_SCORER].calls == 0


def test_vectara_failure_for_en_falls_back_to_local_without_retry():
    vectara = StubScorer(VECTARA_SCORER, error=ScorerUnavailable("vectara_http_500"))
    scorers = _stubs(vectara=vectara)
    result = _result(_post(scorers, _body("en", True)))
    assert (result.status, result.scorer) == ("scored", "hhem_2_1_open")
    assert vectara.calls == 1
    assert scorers[LOCAL_SCORER].calls == 1


def test_vectara_failure_for_zh_hans_is_not_checked_without_retry():
    vectara = StubScorer(VECTARA_SCORER, error=ScorerUnavailable("vectara_timeout"))
    scorers = _stubs(vectara=vectara)
    result = _result(_post(scorers, _body("zh-Hans", True)))
    assert (result.status, result.scorer, result.reason) == ("not_checked", "none", "scorer_unavailable")
    assert vectara.calls == 1
    assert scorers[LOCAL_SCORER].calls == 0


def test_vectara_unexpected_error_is_treated_as_unavailable():
    vectara = StubScorer(VECTARA_SCORER, error=RuntimeError("boom"))
    scorers = _stubs(vectara=vectara)
    result = _result(_post(scorers, _body("en", True)))
    assert (result.status, result.scorer) == ("scored", "hhem_2_1_open")
    assert vectara.calls == 1


def test_local_busy_is_scorer_busy():
    scorers = _stubs(local=StubScorer(LOCAL_SCORER, error=ScorerBusy()))
    result = _result(_post(scorers, _body("en", False)))
    assert (result.status, result.scorer, result.reason) == ("not_checked", "none", "scorer_busy")


def test_local_unavailable_for_en_is_scorer_unavailable():
    scorers = _stubs(local=StubScorer(LOCAL_SCORER, available=False))
    result = _result(_post(scorers, _body("en", False)))
    assert (result.status, result.reason) == ("not_checked", "scorer_unavailable")
    assert scorers[LOCAL_SCORER].calls == 0


def test_local_missing_for_en_is_scorer_unavailable():
    result = _result(_post({}, _body("en", False)))
    assert (result.status, result.reason) == ("not_checked", "scorer_unavailable")


def test_local_raising_unavailable_is_scorer_unavailable():
    scorers = _stubs(local=StubScorer(LOCAL_SCORER, error=ScorerUnavailable("model_load_failed")))
    result = _result(_post(scorers, _body("en", False)))
    assert (result.status, result.reason) == ("not_checked", "scorer_unavailable")


@pytest.mark.parametrize("bad", [1.5, -0.1, float("nan")])
def test_out_of_range_score_is_not_reported(bad):
    scorers = _stubs(local=StubScorer(LOCAL_SCORER, score=bad))
    result = _result(_post(scorers, _body("en", False)))
    assert (result.status, result.reason) == ("not_checked", "scorer_unavailable")


def test_premise_over_cap_is_too_long_without_calling_a_scorer():
    scorers = _stubs()
    premise = ["a" * 30_000, "b" * 30_001]
    result = _result(_post(scorers, _body("en", True, premise_texts=premise)))
    assert (result.status, result.scorer, result.reason) == ("not_checked", "none", "too_long")
    assert scorers[VECTARA_SCORER].calls == 0
    assert scorers[LOCAL_SCORER].calls == 0


def test_premise_at_cap_is_scored():
    scorers = _stubs()
    premise = ["a" * 30_000, "b" * 30_000]
    result = _result(_post(scorers, _body("en", False, premise_texts=premise)))
    assert result.status == "scored"


def test_scorer_receives_premise_and_hypothesis():
    seen: list[tuple[list[str], str]] = []
    local = StubScorer(LOCAL_SCORER, on_call=lambda p, h: seen.append((list(p), h)))
    _result(_post(_stubs(local=local), _body("en", False)))
    assert seen == [(["The sky is blue.", "Grass is green."], "The sky is blue.")]


def test_missing_secret_header_is_401():
    scorers = _stubs()
    response = _post(scorers, _body(), headers={})
    assert response.status_code == 401
    assert SidecarError.model_validate(response.json()).error == "unauthorized"
    assert scorers[VECTARA_SCORER].calls == 0


def test_wrong_secret_header_is_401():
    response = _post(_stubs(), _body(), headers={"x-sidecar-secret": "w" * 48})
    assert response.status_code == 401


def test_unconfigured_secret_is_503():
    response = _post(_stubs(), _body(), settings=_settings(None))
    assert response.status_code == 503


def test_unknown_body_field_is_422():
    scorers = _stubs()
    response = _post(scorers, _body(extra_field="x"))
    assert response.status_code == 422
    assert scorers[VECTARA_SCORER].calls == 0


@pytest.mark.parametrize(
    "body",
    [
        {"request_id": "r", "language": "en", "premise_texts": [], "hypothesis": "h", "allow_vectara": False},
        {"request_id": "r", "language": "en", "premise_texts": ["p"], "hypothesis": "", "allow_vectara": False},
        {"request_id": "r", "language": "en", "premise_texts": ["p"], "hypothesis": "h"},
    ],
)
def test_invalid_body_is_422(body):
    response = _post(_stubs(), body)
    assert response.status_code == 422


def test_malformed_json_is_422():
    app = create_app(_settings(), scorers=_stubs())
    response = TestClient(app).post(
        "/v1/groundedness", content=b"{not json", headers={**HEADER, "content-type": "application/json"}
    )
    assert response.status_code == 422


def test_oversized_body_is_413():
    scorers = _stubs()
    body = _body(premise_texts=["x" * (2 * 1024 * 1024)])
    response = _post(scorers, body)
    assert response.status_code == 413
    assert scorers[LOCAL_SCORER].calls == 0


def test_ready_lists_available_scorers():
    scorers = _stubs(local=StubScorer(LOCAL_SCORER, available=False))
    response = TestClient(create_app(_settings(), scorers=scorers)).get("/ready")
    assert response.status_code == 200
    ready = SidecarReady.model_validate(response.json())
    assert ready.status == "ready"
    assert ready.scorers == ["hhem_2_3_vectara"]


def test_ready_lists_both_scorers():
    response = TestClient(create_app(_settings(), scorers=_stubs())).get("/ready")
    assert SidecarReady.model_validate(response.json()).scorers == ["hhem_2_3_vectara", "hhem_2_1_open"]


def test_ready_lists_no_scorers_when_none_are_configured():
    response = TestClient(create_app(_settings(), scorers={})).get("/ready")
    assert response.status_code == 200
    assert response.json()["scorers"] == []


def test_router_never_logs_request_text(caplog):
    caplog.set_level("DEBUG")
    body = _body("en", True, premise_texts=["SECRET-PREMISE-TEXT"], hypothesis="SECRET-HYPOTHESIS-TEXT")
    vectara = StubScorer(VECTARA_SCORER, error=ScorerUnavailable("vectara_http_500"))
    _result(_post(_stubs(vectara=vectara), body))
    joined = "\n".join(record.getMessage() + repr(record.__dict__) for record in caplog.records)
    assert "SECRET-PREMISE-TEXT" not in joined
    assert "SECRET-HYPOTHESIS-TEXT" not in joined


# Local HHEM-2.1-Open scorer (D-12): injected loaders only, no weights, no torch.

class _FakeModel:
    def __init__(self, value: float = 0.91, gate: threading.Event | None = None, started=None):
        self.value = value
        self.gate = gate
        self.started = started
        self.pairs: list = []

    def predict(self, pairs):
        self.pairs.append(pairs)
        if self.started is not None:
            self.started.set()
        if self.gate is not None:
            self.gate.wait(5)
        return [self.value]


class _FakeLoader:
    def __init__(self, model):
        self.model = model
        self.calls: list[tuple[tuple, dict]] = []

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.model


def test_importing_local_hhem_does_not_import_torch_or_transformers(tmp_path):
    code = (
        "import sys\n"
        "import rag_sidecar.groundedness.local_hhem as m\n"
        "from rag_sidecar.settings import SidecarSettings\n"
        "s = m.LocalHhemScorer(SidecarSettings())\n"
        "print(s.available(), 'torch' in sys.modules, 'transformers' in sys.modules)\n"
    )
    env = {**os.environ, "HF_HOME": str(tmp_path), "HF_HUB_CACHE": str(tmp_path / "hub")}
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, check=True)
    assert out.stdout.split() == ["False", "False", "False"]


def test_local_scorer_unavailable_without_weights(monkeypatch, tmp_path):
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    scorer = LocalHhemScorer(SidecarSettings())
    assert scorer.available() is False
    assert LOCAL_SCORER not in build_scorers(SidecarSettings())


def test_local_scorer_unavailable_when_packages_missing_even_with_weights(monkeypatch, tmp_path):
    revision = SidecarSettings().hhem_model_revision
    (tmp_path / "models--vectara--hallucination_evaluation_model" / "snapshots" / revision).mkdir(parents=True)
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    monkeypatch.setattr("rag_sidecar.groundedness.local_hhem._packages_installed", lambda: False)
    assert LocalHhemScorer(SidecarSettings()).available() is False


def test_local_scorer_available_with_packages_and_pinned_snapshot(monkeypatch, tmp_path):
    revision = SidecarSettings().hhem_model_revision
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    monkeypatch.setattr("rag_sidecar.groundedness.local_hhem._packages_installed", lambda: True)
    assert LocalHhemScorer(SidecarSettings()).available() is False
    (tmp_path / "models--vectara--hallucination_evaluation_model" / "snapshots" / revision).mkdir(parents=True)
    assert LocalHhemScorer(SidecarSettings()).available() is True


def test_local_scorer_scores_and_loads_once():
    loader = _FakeLoader(_FakeModel(0.91))
    scorer = LocalHhemScorer(SidecarSettings(), loader=loader)
    assert scorer.available() is True

    async def run():
        return [await scorer.score(["p1", "p2"], "h") for _ in range(3)]

    assert asyncio.run(run()) == [pytest.approx(0.91)] * 3
    assert len(loader.calls) == 1
    assert loader.model.pairs[0] == [("p1\n\np2", "h")]


def test_loader_receives_pinned_revision_and_offline_flags():
    settings = SidecarSettings(hhem_model_revision="0123456789abcdef0123456789abcdef01234567")
    loader = _FakeLoader(_FakeModel(0.5))
    asyncio.run(LocalHhemScorer(settings, loader=loader).score(["p"], "h"))
    args, kwargs = loader.calls[0]
    assert args == (HHEM_MODEL_ID,)
    assert HHEM_MODEL_ID == "vectara/hallucination_evaluation_model"
    assert kwargs == {
        "revision": "0123456789abcdef0123456789abcdef01234567",
        "trust_remote_code": True,
        "local_files_only": True,
    }


def test_second_concurrent_call_is_busy():
    gate = threading.Event()
    started = threading.Event()
    model = _FakeModel(0.7, gate=gate, started=started)
    scorer = LocalHhemScorer(SidecarSettings(), loader=_FakeLoader(model), queue_wait_s=0.05)

    async def run():
        first = asyncio.create_task(scorer.score(["p"], "h"))
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 2.0
        while not started.is_set() and loop.time() < deadline:
            await asyncio.sleep(0.005)
        assert started.is_set(), "first inference never started"
        with pytest.raises(ScorerBusy):
            await scorer.score(["p"], "h")
        gate.set()
        return await first

    assert asyncio.run(run()) == pytest.approx(0.7)
    assert len(model.pairs) == 1


def test_loader_failure_is_unavailable_and_not_retried():
    calls = []

    def broken_loader(*args, **kwargs):
        calls.append(1)
        raise OSError("missing files")

    scorer = LocalHhemScorer(SidecarSettings(), loader=broken_loader)

    async def run():
        for _ in range(2):
            with pytest.raises(ScorerUnavailable):
                await scorer.score(["p"], "h")

    asyncio.run(run())
    assert len(calls) == 1
    assert scorer.available() is False


def test_inference_error_is_unavailable():
    class Broken:
        def predict(self, pairs):
            raise RuntimeError("oom")

    scorer = LocalHhemScorer(SidecarSettings(), loader=_FakeLoader(Broken()))
    with pytest.raises(ScorerUnavailable):
        asyncio.run(scorer.score(["p"], "h"))


def test_local_scorer_through_the_endpoint():
    scorer = LocalHhemScorer(SidecarSettings(), loader=_FakeLoader(_FakeModel(0.88)))
    result = _result(_post({LOCAL_SCORER: scorer}, _body("en", False)))
    assert (result.status, result.scorer) == ("scored", "hhem_2_1_open")
    assert result.score == pytest.approx(0.88)
