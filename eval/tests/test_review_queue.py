import base64
import json
import re
import subprocess
from pathlib import Path

import httpx
import pytest
from fake_langfuse import FakeLangfuse
from pydantic import ValidationError
from rag_sidecar.contracts.review import ReviewQueueItem

from rag_eval.draft import writer
from rag_eval.golden_io import load_golden
from rag_eval.langfuse_api import DEFAULT_BASE_URL, LangfuseApi, LangfuseApiError
from rag_eval.review_queue import detect_language, main, mask_text

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


FROM, TO = "2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z"


@pytest.fixture
def private_root(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    private = repo / "eval" / "golden" / "private"
    private.mkdir(parents=True)
    (repo / ".gitignore").write_text("eval/golden/private/\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    monkeypatch.setattr(writer, "REPO_ROOT", repo)
    monkeypatch.setattr(writer, "PRIVATE_DIR", private)
    monkeypatch.setattr(writer, "DEFAULT_MANIFEST", private / "split-manifest.json")
    return private


def _configure(monkeypatch, fake: FakeLangfuse) -> None:
    monkeypatch.setenv("LANGFUSE_BASE_URL", fake.url)
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", PUBLIC_KEY)
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", SECRET_KEY)


def _stage_span(n: int, parent: int) -> dict:
    return {
        "id": f"{n + 100:016x}",
        "traceId": f"{parent:032x}",
        "parentObservationId": f"{parent:016x}",
        "name": "search",
        "type": "SPAN",
        "startTime": f"2026-11-{parent:02d}T10:00:01.000Z",
        "userId": "tenant-a",
        "tags": ["review_candidate"],
        "input": None,
        "output": None,
        "metadata": {"latency_ms": "12", "status": json.dumps("ok")},
    }


def _read_queue(private: Path) -> list[dict]:
    (path,) = sorted((private / "review-queue").glob("*.jsonl"))
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _write_queue(private: Path, *items: dict, name: str = "queue.jsonl") -> Path:
    path = private / "review-queue" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(ReviewQueueItem(**item).model_dump(mode="json")) + "\n" for item in items), encoding="utf-8")
    return path


def test_mask_text_replaces_each_pii_pattern():
    assert mask_text("write to jane.doe@example.com now") == "write to [EMAIL] now"
    assert mask_text("IBAN IT60X0542811101000000123456 end") == "IBAN [IBAN] end"
    assert mask_text("card 4111 1111 1111 1111 ok") == "card [CARD] ok"
    assert mask_text("call +39 333 123 4567 today") == "call [PHONE] today"
    assert mask_text("tel 13812345678 ok") == "tel [PHONE] ok"
    assert mask_text("id 11010519491231002X ok") == "id [ID] ok"
    assert mask_text("cf RSSMRA85T10A562S and rssmra85t10a562s") == "cf [ID] and [ID]"


def test_mask_text_keeps_a_digit_run_that_fails_the_luhn_check():
    assert mask_text("ref 1234 5678 9012 3456 ok") == "ref 1234 5678 9012 3456 ok"
    assert mask_text("plain text with no personal data") == "plain text with no personal data"


def test_detect_language_picks_zh_it_or_en():
    assert detect_language("我可以请几天年假") == "zh"
    assert detect_language("Quanti giorni di ferie posso avere per anno?") == "it"
    assert detect_language("How many leave days do employees get?") == "en"


def test_pull_writes_one_line_per_candidate_under_the_private_queue(private_root, monkeypatch, capsys):
    root = _obs(1)
    with FakeLangfuse([root, _stage_span(1, 1), _obs(2)]) as fake:
        _configure(monkeypatch, fake)
        assert main(["pull", "--from", FROM, "--to", TO]) == 0
    (path,) = sorted((private_root / "review-queue").glob("*.jsonl"))
    assert path.name == "2026-11-01T00-00-00Z_2026-11-30T00-00-00Z.jsonl"
    rows = _read_queue(private_root)
    assert [row["observation_id"] for row in rows] == [f"{1:016x}", f"{2:016x}"]
    first = ReviewQueueItem.model_validate(rows[0])
    assert first.trace_id == f"{1:032x}"
    assert first.tenant_key == "tenant-a"
    assert first.captured_at == "2026-11-01T10:00:00.000Z"
    assert first.query_masked == "How many leave days do employees get?"
    assert first.answer_masked == "Twenty days per year."
    assert first.context_masked == "Employees receive twenty days of leave per year."
    assert first.model == "generator/model-b"
    assert first.tags == ["review_candidate"]
    assert "wrote 2 items" in capsys.readouterr().out


def test_pull_follows_the_cursor_across_pages_including_an_empty_one(private_root, monkeypatch):
    with FakeLangfuse(pages=[[_obs(1), _obs(2)], [], [_obs(3)]]) as fake:
        _configure(monkeypatch, fake)
        assert main(["pull", "--from", FROM, "--to", TO]) == 0
        assert len(fake.observation_requests()) == 3
    assert [row["trace_id"] for row in _read_queue(private_root)] == [f"{n:032x}" for n in (1, 2, 3)]


def test_pull_reads_plain_strings_as_well_as_json_encoded_ones(private_root, monkeypatch):
    plain = _obs(
        1,
        input="Plain question?",
        output="Plain answer.",
        metadata={"context": "Plain context.", "model": "generator/model-b"},
    )
    with FakeLangfuse([plain]) as fake:
        _configure(monkeypatch, fake)
        assert main(["pull", "--from", FROM, "--to", TO]) == 0
    (row,) = _read_queue(private_root)
    assert (row["query_masked"], row["answer_masked"], row["context_masked"]) == ("Plain question?", "Plain answer.", "Plain context.")


def test_pull_masks_content_that_arrives_unmasked(private_root, monkeypatch):
    leaky = _obs(
        1,
        input=json.dumps("Mail me at jane.doe@example.com or call +39 333 123 4567"),
        output=json.dumps("Sent to jane.doe@example.com"),
        metadata={"context": json.dumps("Card 4111 1111 1111 1111 on file"), "model": json.dumps("generator/model-b")},
    )
    with FakeLangfuse([leaky]) as fake:
        _configure(monkeypatch, fake)
        assert main(["pull", "--from", FROM, "--to", TO]) == 0
    (row,) = _read_queue(private_root)
    assert row["query_masked"] == "Mail me at [EMAIL] or call [PHONE]"
    assert row["answer_masked"] == "Sent to [EMAIL]"
    assert row["context_masked"] == "Card [CARD] on file"
    text = json.dumps(row)
    assert "jane.doe" not in text and "4111" not in text and "333 123" not in text


def test_pull_refuses_an_output_outside_the_private_directory(private_root, monkeypatch, tmp_path, capsys):
    outside = tmp_path / "queue.jsonl"
    with FakeLangfuse([_obs(1)]) as fake:
        _configure(monkeypatch, fake)
        assert main(["pull", "--from", FROM, "--to", TO, "--out", str(outside)]) == 6
        assert fake.requests == []
    assert not outside.exists()
    assert "eval/golden/private" in capsys.readouterr().err
    with FakeLangfuse([_obs(1)]) as fake:
        _configure(monkeypatch, fake)
        assert main(["pull", "--from", FROM, "--to", TO, "--out-dir", str(tmp_path)]) == 6
    assert list(tmp_path.glob("*.jsonl")) == []


def test_pull_without_keys_prints_a_notice_and_exits_zero(private_root, monkeypatch, capsys):
    with FakeLangfuse([_obs(1)]) as fake:
        monkeypatch.setenv("LANGFUSE_BASE_URL", fake.url)
        assert main(["pull", "--from", FROM, "--to", TO]) == 0
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", PUBLIC_KEY)
        assert main(["pull", "--from", FROM, "--to", TO]) == 0
        assert fake.requests == []
    out = capsys.readouterr().out
    assert out.count("::notice::langfuse keys not configured, skipping review queue") == 2
    assert not (private_root / "review-queue").exists()


def test_pull_never_prints_the_keys_and_reports_an_api_failure(private_root, monkeypatch, capsys):
    with FakeLangfuse([_obs(1)]) as fake:
        fake.observations_status = 500
        _configure(monkeypatch, fake)
        assert main(["pull", "--from", FROM, "--to", TO]) == 4
    captured = capsys.readouterr()
    assert "500" in captured.err
    assert PUBLIC_KEY not in captured.out + captured.err and SECRET_KEY not in captured.out + captured.err
    assert not (private_root / "review-queue").exists()


def test_pull_rejects_a_window_that_ends_before_it_starts(private_root, monkeypatch):
    with FakeLangfuse([_obs(1)]) as fake:
        _configure(monkeypatch, fake)
        assert main(["pull", "--from", TO, "--to", FROM]) == 2
        assert main(["pull", "--from", "yesterday", "--to", TO]) == 2
        assert fake.requests == []


def test_promote_writes_a_draft_production_item_under_the_private_directory(private_root):
    queue = _write_queue(private_root, _queue_item())
    out = private_root / "promoted.jsonl"
    assert main(["promote", _queue_item()["trace_id"], "--queue", str(queue), "--out", str(out)]) == 0
    (item,) = load_golden(out)
    assert item.provenance == "production"
    assert item.review_status == "draft"
    assert item.question == "How many leave days do employees get?"
    assert item.language == "en"
    assert item.gold_evidence == []
    assert re.fullmatch(r"prod-en-[0-9a-f]{10}", item.id)
    assert item.split in ("dev", "test")
    assert json.loads((private_root / "split-manifest.json").read_text(encoding="utf-8"))["assignments"][item.id] == item.split


def test_promote_finds_the_item_in_the_default_queue_and_writes_the_default_file(private_root):
    _write_queue(private_root, _queue_item(), name="a.jsonl")
    _write_queue(private_root, _queue_item(trace_id="f" * 32, observation_id="f" * 16, query_masked="Quanti giorni di ferie posso avere per anno?"), name="b.jsonl")
    assert main(["promote", "f" * 32]) == 0
    (item,) = load_golden(private_root / "promoted.jsonl")
    assert item.language == "it" and item.id.startswith("prod-it-")


def test_promote_honours_the_stored_language_and_an_explicit_override(private_root):
    _write_queue(private_root, _queue_item(language="zh", query_masked="How many leave days do employees get?"))
    assert main(["promote", _queue_item()["trace_id"]]) == 0
    assert load_golden(private_root / "promoted.jsonl")[0].language == "zh"
    out = private_root / "override.jsonl"
    assert main(["promote", _queue_item()["trace_id"], "--language", "it", "--out", str(out)]) == 0
    assert load_golden(out)[0].language == "it"


def test_promote_twice_keeps_one_item(private_root, capsys):
    _write_queue(private_root, _queue_item())
    assert main(["promote", _queue_item()["trace_id"]]) == 0
    assert main(["promote", _queue_item()["trace_id"]]) == 0
    assert len(load_golden(private_root / "promoted.jsonl")) == 1
    assert "already" in capsys.readouterr().out


def test_promote_an_unknown_id_or_a_blank_query_exits_two(private_root, capsys):
    _write_queue(private_root, _queue_item(), _queue_item(trace_id="e" * 32, observation_id="e" * 16, query_masked="   "))
    assert main(["promote", "0" * 32]) == 2
    assert main(["promote", "e" * 32]) == 2
    assert not (private_root / "promoted.jsonl").exists()
    assert "not found" in capsys.readouterr().err


def test_promote_refuses_an_output_outside_the_private_directory(private_root, tmp_path, capsys):
    queue = _write_queue(private_root, _queue_item())
    outside = tmp_path / "promoted.jsonl"
    assert main(["promote", _queue_item()["trace_id"], "--queue", str(queue), "--out", str(outside)]) == 6
    assert not outside.exists()
    assert "eval/golden/private" in capsys.readouterr().err


def test_private_files_stay_ignored_by_git(private_root, monkeypatch):
    with FakeLangfuse([_obs(1)]) as fake:
        _configure(monkeypatch, fake)
        assert main(["pull", "--from", FROM, "--to", TO]) == 0
    assert main(["promote", f"{1:032x}"]) == 0
    status = subprocess.run(
        ["git", "status", "--porcelain", "eval/golden/private"], cwd=private_root.parents[2], capture_output=True, text=True, check=True
    )
    assert status.stdout.strip() == ""


ADMIN_TOKEN = "admin-bearer-placeholder-token"
APP_URL = "http://app.invalid"


def _db_item(trace: str, answer_id: str, reasons: list[str], **overrides) -> dict:
    row = {
        "trace_id": trace,
        "observation_id": answer_id,
        "captured_at": "2026-11-05T10:00:00.000Z",
        "tenant_key": "s:default",
        "language": "en",
        "query_masked": "How many leave days do employees get? mail [EMAIL]",
        "answer_masked": "Twenty days per year.",
        "context_masked": "Employees receive twenty days of leave per year.",
        "model": "generator/model-b",
        "tags": ["review_candidate", *[f"review:{reason}" for reason in reasons]],
        "reasons": reasons,
    }
    row.update(overrides)
    return row


def _mock_app(monkeypatch, items: list[dict], status: int = 200, seen: list | None = None) -> None:
    from rag_eval import review_queue

    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        if status != 200:
            return httpx.Response(status, json={"error": "nope"})
        return httpx.Response(200, json={"items": items})

    monkeypatch.setattr(review_queue, "_http_client", lambda: httpx.Client(transport=httpx.MockTransport(handler), timeout=5.0))


def test_pull_fills_reasons_from_review_tags_and_marks_plain_candidates_sampled(private_root, monkeypatch):
    rows = [
        _obs(1, tags=["review_candidate"]),
        _obs(2, tags=["review_candidate", "review:feedback_negative"]),
        _obs(3, tags=["review_candidate", "review:groundedness_flagged", "review:unknown_reason"]),
    ]
    with FakeLangfuse(rows) as fake:
        _configure(monkeypatch, fake)
        assert main(["pull", "--from", FROM, "--to", TO]) == 0
    by_trace = {row["trace_id"]: row for row in _read_queue(private_root)}
    assert by_trace[f"{1:032x}"]["reasons"] == ["sampled"]
    assert by_trace[f"{2:032x}"]["reasons"] == ["feedback_negative"]
    assert by_trace[f"{3:032x}"]["reasons"] == ["groundedness_flagged"]


def test_pull_deduplicates_langfuse_items_by_trace_id_and_unions_reasons(private_root, monkeypatch):
    sampled = _obs(1, tags=["review_candidate"])
    flagged = _obs(1, id=f"{99:016x}", startTime="2026-11-01T10:00:09.000Z", tags=["review_candidate", "review:feedback_negative"])
    with FakeLangfuse([sampled, flagged]) as fake:
        _configure(monkeypatch, fake)
        assert main(["pull", "--from", FROM, "--to", TO]) == 0
    (row,) = _read_queue(private_root)
    assert row["trace_id"] == f"{1:032x}"
    assert row["reasons"] == ["sampled", "feedback_negative"]
    assert "review:feedback_negative" in row["tags"]


def test_pull_source_db_reads_the_admin_route_with_the_bearer_token(private_root, monkeypatch, capsys):
    seen: list[httpx.Request] = []
    items = [_db_item("a" * 32, "00000000-0000-4000-8000-000000000001", ["feedback_negative"])]
    _mock_app(monkeypatch, items, seen=seen)
    monkeypatch.setenv("RAG_ADMIN_BEARER", ADMIN_TOKEN)
    assert main(["pull", "--from", FROM, "--to", TO, "--source", "db", "--base-url", APP_URL]) == 0
    (request,) = seen
    assert request.url.path == "/api/rag/admin/review-candidates"
    assert request.url.params["from"] == FROM and request.url.params["to"] == TO
    assert request.headers["authorization"] == f"Bearer {ADMIN_TOKEN}"
    (row,) = _read_queue(private_root)
    assert row["observation_id"] == "00000000-0000-4000-8000-000000000001"
    assert row["reasons"] == ["feedback_negative"]
    captured = capsys.readouterr()
    assert ADMIN_TOKEN not in captured.out + captured.err


def test_pull_source_db_masks_again_and_skips_invalid_items(private_root, monkeypatch):
    items = [
        _db_item("b" * 32, "00000000-0000-4000-8000-000000000002", ["groundedness_flagged"], answer_masked="Sent to jane.doe@example.com"),
        {"trace_id": "c" * 32, "smuggled": True},
    ]
    _mock_app(monkeypatch, items)
    monkeypatch.setenv("RAG_ADMIN_BEARER", ADMIN_TOKEN)
    assert main(["pull", "--from", FROM, "--to", TO, "--source", "db", "--base-url", APP_URL]) == 0
    (row,) = _read_queue(private_root)
    assert row["answer_masked"] == "Sent to [EMAIL]"


def test_pull_source_db_without_the_token_exits_non_zero_naming_the_variable(private_root, monkeypatch, capsys):
    seen: list[httpx.Request] = []
    _mock_app(monkeypatch, [], seen=seen)
    monkeypatch.delenv("RAG_ADMIN_BEARER", raising=False)
    assert main(["pull", "--from", FROM, "--to", TO, "--source", "db", "--base-url", APP_URL]) == 2
    assert "RAG_ADMIN_BEARER" in capsys.readouterr().err
    monkeypatch.setenv("CUSTOM_ADMIN_TOKEN", "")
    assert main(["pull", "--from", FROM, "--to", TO, "--source", "db", "--base-url", APP_URL, "--token-env", "CUSTOM_ADMIN_TOKEN"]) == 2
    assert "CUSTOM_ADMIN_TOKEN" in capsys.readouterr().err
    assert seen == []
    assert not (private_root / "review-queue").exists()


def test_pull_source_db_needs_a_base_url(private_root, monkeypatch, capsys):
    _mock_app(monkeypatch, [])
    monkeypatch.setenv("RAG_ADMIN_BEARER", ADMIN_TOKEN)
    assert main(["pull", "--from", FROM, "--to", TO, "--source", "db"]) == 2
    assert "--base-url" in capsys.readouterr().err


def test_pull_source_db_reports_an_http_failure_without_the_token(private_root, monkeypatch, capsys):
    _mock_app(monkeypatch, [], status=403)
    monkeypatch.setenv("RAG_ADMIN_BEARER", ADMIN_TOKEN)
    assert main(["pull", "--from", FROM, "--to", TO, "--source", "db", "--base-url", APP_URL]) == 4
    captured = capsys.readouterr()
    assert "403" in captured.err
    assert ADMIN_TOKEN not in captured.out + captured.err
    assert not (private_root / "review-queue").exists()


def test_pull_source_both_merges_and_deduplicates_by_trace_id(private_root, monkeypatch):
    shared = f"{1:032x}"
    items = [
        _db_item(shared, "00000000-0000-4000-8000-000000000003", ["feedback_negative"]),
        _db_item("d" * 32, "00000000-0000-4000-8000-000000000004", ["groundedness_flagged"]),
    ]
    _mock_app(monkeypatch, items)
    monkeypatch.setenv("RAG_ADMIN_BEARER", ADMIN_TOKEN)
    with FakeLangfuse([_obs(1, tags=["review_candidate"]), _obs(2, tags=["review_candidate"])]) as fake:
        _configure(monkeypatch, fake)
        assert main(["pull", "--from", FROM, "--to", TO, "--source", "both", "--base-url", APP_URL]) == 0
    rows = _read_queue(private_root)
    assert sorted(row["trace_id"] for row in rows) == sorted([shared, f"{2:032x}", "d" * 32])
    merged = next(row for row in rows if row["trace_id"] == shared)
    assert merged["reasons"] == ["sampled", "feedback_negative"]


def test_pull_source_langfuse_is_the_default_and_never_calls_the_app(private_root, monkeypatch):
    seen: list[httpx.Request] = []
    _mock_app(monkeypatch, [], seen=seen)
    monkeypatch.setenv("RAG_ADMIN_BEARER", ADMIN_TOKEN)
    with FakeLangfuse([_obs(1)]) as fake:
        _configure(monkeypatch, fake)
        assert main(["pull", "--from", FROM, "--to", TO]) == 0
    assert seen == []
    assert len(_read_queue(private_root)) == 1


# --- promote-db (Phase 5.1.1 D-20, D-21, D-22, D-29) ---

import hashlib  # noqa: E402

from rag_eval.split import DOCGROUP_SPLIT_RULE, load_group_manifest, write_manifest  # noqa: E402

DB_TENANT = "o:11111111-2222-4333-8444-555555555555"
DB_TENANT_HASH = hashlib.sha256(DB_TENANT.encode()).hexdigest()[:16]
DOC_ONE = "d0000000-0000-4000-8000-000000000001"
DOC_TWO = "d0000000-0000-4000-8000-000000000002"
CHUNK_ONE = "The widget accepts three inputs and returns one summary value."
CHUNK_TWO = "Archived records move to cold storage after the retention period."


def _review_id(n: int) -> str:
    return f"a0000000-0000-4000-8000-{n:012x}"


def _golden_line(n: int, *, question: str | None = None, document_id: str = DOC_ONE, chunk: str = CHUNK_ONE, quote: str | None = None, verified: bool | None = None, **label_overrides) -> dict:
    quote = quote if quote is not None else chunk.split(" and ")[0].split(" after ")[0]
    label = {
        "answerable": True,
        "category": "general",
        "language": "en",
        "expected_answer": "A synthetic expected answer.",
        "evidence": [
            {"chunk_id": f"chunk-{n}", "document_id": document_id, "document_name": f"doc-{document_id[-1]}.md", "section": "Overview", "quote": quote}
        ],
        "triage": ["golden"],
        "pii_checked": True,
    }
    label.update(label_overrides)
    return {
        "id": _review_id(n),
        "tenant_key": DB_TENANT,
        "query_masked": question if question is not None else f"How does synthetic feature number {n} behave?",
        "query_language": "en",
        "channel": "chat",
        "outcome": "answered",
        "reasons": ["feedback_negative"],
        "occurrences": 1,
        "labelled_at": "2026-11-20T10:00:00.000Z",
        "split": None,
        "split_group": None,
        "mining_window": "2026-11-16",
        "mined_at": "2026-11-17T10:00:00.000Z",
        "label": label,
        "evidence": [
            {
                **span,
                "chunk_text": chunk,
                "quote_verified": (quote in chunk) if verified is None else verified,
            }
            for span in label["evidence"]
        ],
    }


class _App:
    def __init__(self, lines: list[dict], *, export_status: int = 200, mark_status: int = 200) -> None:
        self.lines = lines
        self.export_status = export_status
        self.mark_status = mark_status
        self.requests: list[httpx.Request] = []
        self.marked: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/api/rag/admin/feedback-loop/export" and request.method == "GET":
            if self.export_status != 200:
                return httpx.Response(self.export_status, json={"error": "nope"})
            body = "".join(json.dumps(line) + "\n" for line in self.lines)
            return httpx.Response(200, text=body, headers={"content-type": "application/x-ndjson"})
        if request.url.path == "/api/rag/admin/feedback-loop/export/mark" and request.method == "POST":
            payload = json.loads(request.content)
            if self.mark_status != 200:
                return httpx.Response(self.mark_status, json={"success": False, "marked": [], "conflicts": [], "ignored": []})
            self.marked.append(payload)
            exported = {item["id"] for item in payload["items"]}
            self.lines = [line for line in self.lines if line["id"] not in exported]
            return httpx.Response(200, json={"success": True, "marked": sorted(exported), "conflicts": [], "ignored": []})
        return httpx.Response(404)


def _install(monkeypatch, app: _App) -> None:
    from rag_eval import review_queue

    monkeypatch.setattr(review_queue, "_http_client", lambda: httpx.Client(transport=httpx.MockTransport(app.handler), timeout=5.0))
    monkeypatch.setenv("RAG_ADMIN_BEARER", "admin-token-placeholder")


def _promote_db(*extra: str) -> int:
    return main(["promote-db", "--tenant", DB_TENANT, "--base-url", "https://app.example.test", *extra])


def _domain_dir(private: Path) -> Path:
    return private / "domain" / DB_TENANT_HASH


def test_promote_db_promotes_two_items_with_production_provenance_and_marks_their_splits(private_root, monkeypatch, capsys):
    app = _App([_golden_line(1), _golden_line(2, document_id=DOC_TWO, chunk=CHUNK_TWO)])
    _install(monkeypatch, app)
    assert _promote_db() == 0
    items = load_golden(_domain_dir(private_root) / "golden.jsonl")
    assert len(items) == 2
    assert {item.provenance for item in items} == {"production"}
    assert {item.review_status for item in items} == {"approved"}
    get = app.requests[0]
    assert get.method == "GET" and get.url.params["kind"] == "golden" and get.url.params["tenant"] == DB_TENANT
    assert get.headers["authorization"] == "Bearer admin-token-placeholder"
    manifest = load_group_manifest(_domain_dir(private_root) / "split-manifest.json")
    assert manifest.rule == DOCGROUP_SPLIT_RULE
    assert set(manifest.assignments) == {item.id for item in items}
    assert manifest.group_assignments == {
        hashlib.sha256(item.gold_evidence[0].document_id.encode()).hexdigest(): item.split for item in items
    }
    (mark,) = app.marked
    assert mark["tenant"] == DB_TENANT
    by_review = {entry["id"]: entry for entry in mark["items"]}
    assert set(by_review) == {_review_id(1), _review_id(2)}
    for item in items:
        doc = item.gold_evidence[0].document_id
        review = _review_id(1) if doc == DOC_ONE else _review_id(2)
        assert by_review[review]["split"] == item.split
        assert by_review[review]["split_group"] == hashlib.sha256(doc.encode()).hexdigest()
    out = capsys.readouterr()
    assert "admin-token-placeholder" not in out.out + out.err
    assert "synthetic feature" not in out.out + out.err and CHUNK_ONE not in out.out + out.err


def test_promote_db_spans_keep_the_document_id_and_carry_no_chunk_user_chat_or_trace_id(private_root, monkeypatch):
    _install(monkeypatch, _App([_golden_line(1)]))
    assert _promote_db() == 0
    raw = (_domain_dir(private_root) / "golden.jsonl").read_text(encoding="utf-8")
    (line,) = [json.loads(row) for row in raw.splitlines() if row.strip()]
    (span,) = line["gold_evidence"]
    assert span == {"document": "doc-1.md", "section": "Overview", "quote": "The widget accepts three inputs", "document_id": DOC_ONE}
    for forbidden in ("chunk-1", _review_id(1), "user_id", "chat_id", "trace_id"):
        assert forbidden not in raw
    assert line["id"].startswith("prod-en-")


def test_promote_db_leaves_the_item_rule_manifest_at_the_private_root_untouched(private_root, monkeypatch):
    root_manifest = private_root / "split-manifest.json"
    write_manifest(root_manifest, {"prod-en-existing01": "dev"})
    before = root_manifest.read_bytes()
    _install(monkeypatch, _App([_golden_line(1)]))
    assert _promote_db() == 0
    assert root_manifest.read_bytes() == before
    assert (_domain_dir(private_root) / "split-manifest.json").is_file()


def test_promote_db_refuses_a_question_that_changes_under_masking(private_root, monkeypatch, capsys):
    app = _App([_golden_line(1, question="Contact jane.doe@example.com about synthetic feature one?")])
    _install(monkeypatch, app)
    assert _promote_db() == 2
    assert not (_domain_dir(private_root) / "golden.jsonl").exists()
    assert app.marked == []
    err = capsys.readouterr().err
    assert _review_id(1)[:8] in err or "masking" in err
    assert "jane.doe" not in err


def test_promote_db_uses_the_paraphrased_question_with_human_provenance(private_root, monkeypatch):
    _install(monkeypatch, _App([_golden_line(1, paraphrased_question="How does the synthetic widget behave?")]))
    assert _promote_db() == 0
    (item,) = load_golden(_domain_dir(private_root) / "golden.jsonl")
    assert item.provenance == "human" and item.question == "How does the synthetic widget behave?"


def test_promote_db_refuses_an_unconfirmed_near_duplicate_and_names_the_existing_id(private_root, monkeypatch, capsys):
    _install(monkeypatch, _App([_golden_line(1, question="How does synthetic feature alpha behave in practice?")]))
    assert _promote_db() == 0
    (existing,) = load_golden(_domain_dir(private_root) / "golden.jsonl")
    app = _App([_golden_line(2, question="how does synthetic feature alpha behave in practice", document_id=DOC_TWO, chunk=CHUNK_TWO)])
    _install(monkeypatch, app)
    assert _promote_db() == 2
    assert existing.id in capsys.readouterr().err
    assert len(load_golden(_domain_dir(private_root) / "golden.jsonl")) == 1
    assert app.marked == []


def test_promote_db_promotes_a_confirmed_near_duplicate_with_the_tag_and_the_same_group(private_root, monkeypatch):
    _install(monkeypatch, _App([_golden_line(1, question="How does synthetic feature alpha behave in practice?")]))
    assert _promote_db() == 0
    (existing,) = load_golden(_domain_dir(private_root) / "golden.jsonl")
    app = _App(
        [
            _golden_line(
                2,
                question="how does synthetic feature alpha behave in practice",
                document_id=DOC_TWO,
                chunk=CHUNK_TWO,
                confirm_near_duplicate_of=existing.id,
            )
        ]
    )
    _install(monkeypatch, app)
    assert _promote_db() == 0
    items = {item.id: item for item in load_golden(_domain_dir(private_root) / "golden.jsonl")}
    (new_id,) = set(items) - {existing.id}
    assert f"near_duplicate_confirmed:{existing.id}" in items[new_id].tags
    assert items[new_id].split == existing.split
    (mark,) = app.marked
    assert mark["items"][0]["split_group"] == hashlib.sha256(DOC_ONE.encode()).hexdigest()


def test_promote_db_refuses_a_quote_no_longer_in_its_chunk(private_root, monkeypatch, capsys):
    app = _App([_golden_line(1, quote="The widget accepts three inputs", chunk="The chunk was rewritten entirely.", verified=False)])
    _install(monkeypatch, app)
    assert _promote_db() == 2
    assert not (_domain_dir(private_root) / "golden.jsonl").exists()
    assert "quote" in capsys.readouterr().err


def test_promote_db_rechecks_the_quote_even_when_the_server_says_verified(private_root, monkeypatch):
    app = _App([_golden_line(1, quote="The widget accepts three inputs", chunk="The chunk was rewritten entirely.", verified=True)])
    _install(monkeypatch, app)
    assert _promote_db() == 2


def test_promote_db_refuses_an_output_outside_the_private_directory(private_root, monkeypatch, capsys, tmp_path):
    _install(monkeypatch, _App([_golden_line(1)]))
    assert _promote_db("--out-dir", str(tmp_path / "elsewhere")) == 6
    assert "eval/golden/private" in capsys.readouterr().err


def test_promote_db_without_the_token_exits_non_zero_naming_the_variable(private_root, monkeypatch, capsys):
    app = _App([_golden_line(1)])
    _install(monkeypatch, app)
    monkeypatch.delenv("RAG_ADMIN_BEARER")
    assert _promote_db() == 2
    assert "RAG_ADMIN_BEARER" in capsys.readouterr().err
    assert app.requests == []
    monkeypatch.setenv("CUSTOM_BEARER", "")
    assert _promote_db("--token-env", "CUSTOM_BEARER") == 2
    assert "CUSTOM_BEARER" in capsys.readouterr().err


def test_promote_db_twice_adds_nothing_the_second_time(private_root, monkeypatch):
    app = _App([_golden_line(1), _golden_line(2, document_id=DOC_TWO, chunk=CHUNK_TWO)])
    _install(monkeypatch, app)
    assert _promote_db() == 0
    golden = _domain_dir(private_root) / "golden.jsonl"
    manifest = _domain_dir(private_root) / "split-manifest.json"
    before = (golden.read_bytes(), manifest.read_bytes())
    assert _promote_db() == 0
    assert (golden.read_bytes(), manifest.read_bytes()) == before
    assert len(app.marked) == 1


def test_promote_db_re_marks_an_item_already_in_the_set_without_adding_it_again(private_root, monkeypatch):
    app = _App([_golden_line(1)], mark_status=503)
    _install(monkeypatch, app)
    assert _promote_db() == 4
    golden = _domain_dir(private_root) / "golden.jsonl"
    assert len(load_golden(golden)) == 1
    app.mark_status = 200
    assert _promote_db() == 0
    assert len(load_golden(golden)) == 1
    assert [entry["id"] for entry in app.marked[0]["items"]] == [_review_id(1)]


def test_promote_db_reports_an_export_failure_or_an_invalid_line_with_exit_four(private_root, monkeypatch, capsys):
    _install(monkeypatch, _App([_golden_line(1)], export_status=503))
    assert _promote_db() == 4
    bad = _golden_line(1)
    bad["user_id"] = _review_id(9)
    _install(monkeypatch, _App([bad]))
    assert _promote_db() == 4
    assert not (_domain_dir(private_root) / "golden.jsonl").exists()
    assert "admin-token-placeholder" not in capsys.readouterr().err


def test_promote_db_refuses_a_line_of_another_tenant(private_root, monkeypatch):
    other = _golden_line(1)
    other["tenant_key"] = "o:99999999-2222-4333-8444-555555555555"
    _install(monkeypatch, _App([other]))
    assert _promote_db() == 4
    assert not (_domain_dir(private_root) / "golden.jsonl").exists()


def test_promote_db_rejects_an_invalid_tenant_key(private_root, monkeypatch, capsys):
    _install(monkeypatch, _App([]))
    assert main(["promote-db", "--tenant", "tenant-a", "--base-url", "https://app.example.test"]) == 2
    assert "tenant" in capsys.readouterr().err
