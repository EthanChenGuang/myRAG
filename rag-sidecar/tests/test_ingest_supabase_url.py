import pytest

from rag_sidecar.ingest.supabase_url import assert_supabase_api_url


def test_accepts_project_api_url():
    assert assert_supabase_api_url("https://example.supabase.co/") == "https://example.supabase.co"


def test_rejects_direct_dsn():
    with pytest.raises(ValueError, match="direct Postgres"):
        assert_supabase_api_url("postgresql://postgres@db.x.supabase.co:5432/postgres")


def test_rejects_db_host():
    with pytest.raises(ValueError, match="db.\\*"):
        assert_supabase_api_url("https://db.x.supabase.co")