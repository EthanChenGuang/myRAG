"""Validate Supabase URLs for PostgREST RPC workers (not direct Postgres)."""

from __future__ import annotations

import re
from urllib.parse import urlparse

_DIRECT_DSN = re.compile(r"^postgres(ql)?://", re.I)
_DIRECT_DB_HOST = re.compile(r"^db\.[a-z0-9-]+\.supabase\.co$", re.I)
_PROJECT_API_HOST = re.compile(r"^[a-z0-9-]+\.supabase\.co$", re.I)


def assert_supabase_api_url(raw: str, *, label: str = "NEXT_PUBLIC_SUPABASE_URL") -> str:
    trimmed = (raw or "").strip()
    if not trimmed:
        raise ValueError(f"{label} must be set to the Supabase project HTTPS URL (PostgREST)")
    if _DIRECT_DSN.match(trimmed):
        raise ValueError(f"{label} must not be a direct Postgres DSN")
    if ":5432" in trimmed:
        raise ValueError(f"{label} must not target the database port")
    parsed = urlparse(trimmed if "://" in trimmed else f"https://{trimmed}")
    if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise ValueError(f"{label} must use https for the project API URL")
    host = parsed.hostname or ""
    if _DIRECT_DB_HOST.match(host):
        raise ValueError(f"{label} must not use the db.* direct database host")
    if host not in {"localhost", "127.0.0.1"} and not _PROJECT_API_HOST.match(host):
        raise ValueError(f"{label} must be a Supabase project hostname")
    return f"{parsed.scheme}://{host}"