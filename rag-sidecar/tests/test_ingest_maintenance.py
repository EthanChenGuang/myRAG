"""Retention settings and maintenance loop wiring."""

from __future__ import annotations

import pytest

from rag_sidecar.ingest.maintenance import maintenance_settings


def test_maintenance_settings_defaults():
    interval, retention = maintenance_settings({})
    assert interval == 3600
    assert retention == 90


def test_maintenance_settings_reads_env_names_only():
    interval, retention = maintenance_settings(
        {"RAG_INGEST_MAINTENANCE_INTERVAL_SECONDS": "120", "RAG_INGEST_JOB_RETENTION_DAYS": "30"}
    )
    assert interval == 120
    assert retention == 30


@pytest.mark.parametrize("bad", ["", "x", "-1"])
def test_invalid_values_fall_back(bad: str):
    interval, retention = maintenance_settings({"RAG_INGEST_MAINTENANCE_INTERVAL_SECONDS": bad, "RAG_INGEST_JOB_RETENTION_DAYS": bad})
    assert interval == 3600
    assert retention == 90