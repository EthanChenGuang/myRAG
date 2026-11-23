import base64
import json

import httpx
import pytest
from fake_langfuse import FakeLangfuse
from pydantic import ValidationError
from rag_sidecar.contracts.review import ReviewQueueItem

from rag_eval.langfuse_api import DEFAULT_BASE_URL, LangfuseApi, LangfuseApiError

PUBLIC_KEY = "pk-test-placeholder"
SECRET_KEY = "sk-test-placeholder"


@pytest.fixture(autouse=True)
def _loopback_only(monkeypatch):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    for name in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"):
        monkeypatch.delenv(name, raising=False)


def _obs(n: int = 1, **overrides) -> dict:
    row = {
        "id": f"{n:016x}",
        "traceId": f"{n:032x}",
        "parentObservationId": None,
        "name": "rag-request",
        "type": "SPAN",
        "startTime": f"2026-11-{n:02d}T10:00:00.000Z",
        "userId": "tenant-a",
        "tags": ["review_candidate"],
        "input": json.dumps("How many leave days do employees get?"),
        "output": json.dumps("Twenty days per year."),
        "metadata": {
            "tenantKey": json.dumps("tenant-a"),
            "context": json.dumps("Employees receive twenty days of leave per year."),
            "model": json.dumps("generator/model-b"),
        },
    }
    row.update(overrides)
    return row


def _api(fake: FakeLangfuse) -> LangfuseApi:
    return LangfuseApi(fake.url, PUBLIC_KEY, SECRET_KEY, client=httpx.Client(trust_env=False, timeout=5.0))


def _queue_item(**overrides) -> dict:
    row = {
        "trace_id": "0123456789abcdef0123456789abcdef",
        "observation_id": "0123456789abcdef",
        "captured_at": "2026-11-01T10:00:00.000Z",
        "tenant_key": "tenant-a",
        "query_masked": "How many leave days do employees get?",
        "answer_masked": "Twenty days per year.",
        "context_masked": "Employees receive twenty days of leave per year.",
        "model": "generator/model-b",
        "tags": ["review_candidate"],
    }
    row.update(overrides)
    return row


def test_contract_review_queue_item_validates_and_forbids_extra_keys():
    item = ReviewQueueItem(**_queue_item())
    assert item.language is None and item.tags == ["review_candidate"]
    with pytest.raises(ValidationError):
        ReviewQueueItem(**_queue_item(smuggled="x"))
    with pytest.raises(ValidationError):
        ReviewQueueItem(**_queue_item(language="fr"))


def test_api_observations_follows_the_cursor_across_an_empty_middle_page():
    first, last = [_obs(1), _obs(2)], [_obs(3)]
    with FakeLangfuse(pages=[first, [], last]) as fake:
        found = list(_api(fake).observations("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"))
        assert [row["id"] for row in found] == [row["id"] for row in first + last]
        requests = fake.observation_requests()
        assert len(requests) == 3
        assert "cursor" not in requests[0]["query"]
        assert [r["query"]["cursor"] for r in requests[1:]] == [["p1"], ["p2"]]


def test_api_observations_sends_basic_auth_and_the_documented_query():
    with FakeLangfuse([_obs(1)]) as fake:
        list(_api(fake).observations("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"))
        (request,) = fake.observation_requests()
    expected ="Basic " + base64.b64encode(f"{PUBLIC_KEY}:{SECRET_KEY}".encode()).decode()
    assert request["authorization"] == expected
    query = request["query"]
    assert query["fromStartTime"] == ["2026-11-01T00:00:00Z"]
    assert query["toStartTime"] == ["2026-12-01T00:00:00Z"]
    assert query["fields"] == ["core,basic,io,metadata,trace_context"]
    assert query["limit"] == ["1000"]
    assert json.loads(query["filter"][0]) == [
        {"type": "arrayOptions", "column": "tags", "operator": "any of", "value": ["review_candidate"]}
    ]


def test_api_never_sends_parse_io_as_json():
    with FakeLangfuse([_obs(1)]) as fake:
        found = list(_api(fake).observations("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"))
        assert len(found) == 1
        assert all("parseIoAsJson" not in entry["query"] for entry in fake.requests)


def test_api_post_scores_posts_an_array_and_reports_202():
    scores = [{"traceId": "t1", "name": "faithfulness", "value": 0.9}, {"traceId": "t2", "name": "faithfulness", "value": 0.4}]
    with FakeLangfuse(scores_status=202) as fake:
        result = _api(fake).post_scores(scores)
        (request,) = fake.score_requests()
        assert request["body"] == scores
        assert fake.scores == scores
    assert (result.status, result.accepted, result.rejected) == (202, 2, 0)


def test_api_post_scores_reports_a_207_without_retrying():
    scores = [{"traceId": "t1", "name": "faithfulness", "value": 0.9}, {"traceId": "t2", "name": "faithfulness", "value": 0.4}]
    with FakeLangfuse(scores_status=207, reject_indexes={1}) as fake:
        result = _api(fake).post_scores(scores)
        assert len(fake.score_requests()) == 1
    assert (result.status, result.accepted, result.rejected) == (207, 1, 1)


def test_api_error_status_raises_without_leaking_the_keys():
    with FakeLangfuse([_obs(1)]) as fake:
        fake.observations_status = 500
        with pytest.raises(LangfuseApiError) as caught:
            list(_api(fake).observations("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"))
    assert "500" in str(caught.value)
    assert PUBLIC_KEY not in str(caught.value) and SECRET_KEY not in str(caught.value)


def test_api_default_base_url_is_langfuse_cloud():
    assert DEFAULT_BASE_URL == "https://cloud.langfuse.com"
