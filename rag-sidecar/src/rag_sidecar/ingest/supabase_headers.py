"""Supabase REST header builder for service keys (F-7)."""

from __future__ import annotations


def _is_jwt_shaped(key: str) -> bool:
    if not key.startswith("eyJ"):
        return False
    parts = key.split(".")
    return len(parts) == 3 and all(parts)


def supabase_headers(key: str, *, content_type: str = "application/json") -> dict[str, str]:
    """Return headers for PostgREST and Storage calls.

    Legacy JWT-shaped keys also need ``Authorization: Bearer``; new ``sb_secret_`` keys
    go on ``apikey`` only.
    """
    if not key or not key.strip():
        raise ValueError("service key must not be empty")
    headers: dict[str, str] = {"apikey": key, "Content-Type": content_type}
    if _is_jwt_shaped(key):
        headers["Authorization"] = f"Bearer {key}"
    return headers