import base64
import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import httpx

DEFAULT_BASE_URL = "https://cloud.langfuse.com"
REVIEW_TAG = "review_candidate"
OBSERVATIONS_PATH = "/api/public/v2/observations"
SCORES_PATH = "/api/public/scores"
OBSERVATION_FIELDS = "core,basic,io,metadata,trace_context"
PAGE_LIMIT = 1000
MAX_PAGES = 10_000
MAX_REPORTED_ERRORS = 20


class LangfuseApiError(RuntimeError):
    pass


@dataclass(frozen=True)
class ScoresResult:
    status: int
    accepted: int
    rejected: int
    errors: tuple[str, ...] = ()


def _count(value: Any) -> int:
    if isinstance(value, list):
        return len(value)
    if isinstance(value, int) and not isinstance(value, bool):
        return max(value, 0)
    return 0


class LangfuseApi:
    def __init__(
        self,
        base_url: str,
        public_key: str,
        secret_key: str,
        client: httpx.Client | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.strip().rstrip("/") or DEFAULT_BASE_URL
        token = base64.b64encode(f"{public_key}:{secret_key}".encode("utf-8")).decode("ascii")
        self._headers = {"Authorization": f"Basic {token}"}
        self._owns_client = client is None
        self._client = client if client is not None else httpx.Client(timeout=timeout)

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "LangfuseApi":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            return self._client.request(method, self._base_url + path, headers=self._headers, **kwargs)
        except httpx.HTTPError as exc:
            raise LangfuseApiError(f"{method} {path} failed: {type(exc).__name__}") from exc

    def observations(
        self,
        from_time: str,
        to_time: str,
        tag: str = REVIEW_TAG,
        *,
        limit: int = PAGE_LIMIT,
    ) -> Iterator[dict[str, Any]]:
        base_params = {
            "fromStartTime": from_time,
            "toStartTime": to_time,
            "fields": OBSERVATION_FIELDS,
            "limit": str(limit),
            "filter": json.dumps(
                [{"type": "arrayOptions", "column": "tags", "operator": "any of", "value": [tag]}],
                separators=(",", ":"),
            ),
        }
        cursor: str | None = None
        seen: set[str] = set()
        for _ in range(MAX_PAGES):
            params = dict(base_params)
            if cursor:
                params["cursor"] = cursor
            response = self._request("GET", OBSERVATIONS_PATH, params=params)
            if response.status_code != 200:
                raise LangfuseApiError(f"observations request failed with HTTP {response.status_code}")
            try:
                body = response.json()
            except ValueError as exc:
                raise LangfuseApiError("observations response is not JSON") from exc
            if not isinstance(body, dict):
                raise LangfuseApiError("observations response has an unexpected shape")
            data = body.get("data")
            if data is None:
                data = []
            if not isinstance(data, list):
                raise LangfuseApiError("observations response has an unexpected shape")
            for row in data:
                if isinstance(row, dict):
                    yield row
            meta = body.get("meta")
            cursor = meta.get("cursor") if isinstance(meta, dict) else None
            if not cursor:
                return
            if cursor in seen:
                raise LangfuseApiError("observations paging repeated a cursor")
            seen.add(cursor)
        raise LangfuseApiError("observations paging exceeded the page limit")

    def post_scores(self, scores: list[dict[str, Any]]) -> ScoresResult:
        if not scores:
            return ScoresResult(status=0, accepted=0, rejected=0)
        response = self._request("POST", SCORES_PATH, json=list(scores))
        status = response.status_code
        if status == 202:
            return ScoresResult(status=202, accepted=len(scores), rejected=0)
        if status == 207:
            try:
                body = response.json()
            except ValueError:
                body = {}
            if not isinstance(body, dict):
                body = {}
            raw_errors = body.get("errors")
            errors = tuple(
                item if isinstance(item, str) else json.dumps(item, sort_keys=True)
                for item in (raw_errors if isinstance(raw_errors, list) else [])[:MAX_REPORTED_ERRORS]
            )
            return ScoresResult(
                status=207,
                accepted=_count(body.get("accepted")),
                rejected=_count(body.get("rejected")),
                errors=errors,
            )
        raise LangfuseApiError(f"scores request failed with HTTP {status}")
