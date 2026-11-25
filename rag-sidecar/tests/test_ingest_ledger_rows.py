"""LedgerClient parses the rows PostgREST returns for ingestion_jobs, which carry columns the contract leaves out."""

from __future__ import annotations

import asyncio

import httpx

from rag_sidecar.ingest.ledger_client import LedgerClient

_JOB_ID = "00000000-0000-4000-8000-000000000001"
_NOW = "2026-01-01T00:00:00+00:00"


def _table_row(**updates: object) -> dict:
    """A row shaped like select * from ingestion_jobs: the error column, an empty detect_counts and the numeric cost as text."""
    base = {
        "id": _JOB_ID,
        "kind": "ingest",
        "status": "preflight",
        "stage": None,
        "tenant_key": "u:00000000-0000-4000-8000-0000000000a1",
        "document_id": None,
        "lineage_id": None,
        "version": None,
        "batch_id": None,
        "source": "config_upload",
        "source_key": "root/a.pdf",
        "file_sha256": "a" * 64,
        "filename": "a.pdf",
        "mime_type": "application/pdf",
        "original_ref": None,
        "priority": 100,
        "retries": 0,
        "max_retries": 3,
        "run_after": None,
        "lease_until": _NOW,
        "locked_by": "worker-a",
        "runner": "worker",
        "settings": {
            "routing": "fixed",
            "cloud_allowed": True,
            "escalation": True,
            "progressive": False,
            "premium_max_pages_per_doc": 50,
            "premium_page_budget": 0,
            "vlm_detect": False,
            "profile_id": "general@1",
            "profile_version": 1,
            "doc_type": "general",
            "embed_mode": "sync",
            "ocr_languages": ["en"],
            "routing_config_version": "1",
        },
        "stage_state": {},
        "doc_class": None,
        "tier": None,
        "parser_used": None,
        "parser_version": None,
        "attempts": [],
        "escalations": 0,
        "pages": None,
        "page_ranges": [],
        "tier_page_counts": {},
        "detect_counts": {},
        "preflight_ref": None,
        "est_cost_usd": "0",
        "embedding_profile": None,
        "error_class": None,
        "error": None,
        "needs_review_reason": None,
        "routing_note": None,
        "provisional_published_at": None,
        "trace_id": None,
        "timings": {},
        "created_at": _NOW,
        "updated_at": _NOW,
        "deleted_at": None,
    }
    base.update(updates)
    return base


def _client(row: dict) -> LedgerClient:
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=row))
    return LedgerClient(base_url="https://example.supabase.co", service_key="sb_secret_placeholder", client=httpx.AsyncClient(transport=transport))


def test_claim_one_accepts_a_table_row_with_the_error_column_and_empty_detect_counts():
    job = asyncio.run(_client(_table_row()).claim_one(_JOB_ID, worker="worker-a"))
    assert job is not None
    assert job.id == _JOB_ID
    assert job.detect_counts is None
    assert job.est_cost_usd == 0


def test_claim_accepts_a_list_of_table_rows():
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=[_table_row(), _table_row(detect_counts={"L1": 1, "L2": 0, "L3": 0, "gated_share": 0.5})]))
    client = LedgerClient(base_url="https://example.supabase.co", service_key="sb_secret_placeholder", client=httpx.AsyncClient(transport=transport))
    jobs = asyncio.run(client.claim(worker="worker-a", limit=2, allow_batch=False))
    assert [job.detect_counts is None for job in jobs] == [True, False]


def test_advance_and_fail_accept_table_rows():
    client = _client(_table_row(status="parsing", stage="parse"))
    advanced = asyncio.run(client.advance(_JOB_ID, "worker-a", stage="parse", status="parsing"))
    assert advanced.status == "parsing"
    failed = asyncio.run(client.fail(_JOB_ID, "worker-a", error_class="x", retryable=False))
    assert failed.id == _JOB_ID


def _attempt_client(payload: object) -> LedgerClient:
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
    return LedgerClient(base_url="https://example.supabase.co", service_key="sb_secret_placeholder", client=httpx.AsyncClient(transport=transport))


def test_record_attempt_reads_a_bare_number_and_a_one_column_row():
    for payload in (3, [3], {"rag_record_parse_attempt": 3}, [{"rag_record_parse_attempt": 3}]):
        number = asyncio.run(_attempt_client(payload).record_attempt(_JOB_ID, "worker-a", {"reason": "fixed_chain"}))
        assert number == 3, payload
