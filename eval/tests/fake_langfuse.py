import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

OBSERVATIONS_PATH = "/api/public/v2/observations"
SCORES_PATH = "/api/public/scores"


class FakeLangfuse:
    """Local twin of tests/helpers/fake-langfuse.mts: observations with cursor paging and the scores array endpoint."""

    def __init__(
        self,
        observations: list[dict[str, Any]] | None = None,
        *,
        pages: list[list[dict[str, Any]]] | None = None,
        page_size: int = 2,
        scores_status: int = 202,
        reject_indexes: set[int] | None = None,
    ) -> None:
        if pages is not None:
            self._pages = [list(page) for page in pages]
        else:
            items = list(observations or [])
            self._pages = [items[start : start + page_size] for start in range(0, len(items), page_size)] or [[]]
        self.scores_status = scores_status
        self.reject_indexes = set(reject_indexes or ())
        self.observations_status = 200
        self.requests: list[dict[str, Any]] = []
        self.scores: list[Any] = []
        self.url = ""
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def observation_requests(self) -> list[dict[str, Any]]:
        return [entry for entry in self.requests if entry["path"] == OBSERVATIONS_PATH]

    def score_requests(self) -> list[dict[str, Any]]:
        return [entry for entry in self.requests if entry["path"] == SCORES_PATH]

    def start(self) -> "FakeLangfuse":
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                return

            def _send(self, status: int, payload: Any) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _record(self, url: Any, query: dict[str, list[str]], body: Any) -> None:
                fake.requests.append(
                    {
                        "method": self.command,
                        "path": url.path,
                        "query": query,
                        "authorization": self.headers.get("authorization"),
                        "content_type": self.headers.get("content-type"),
                        "body": body,
                    }
                )

            def do_GET(self) -> None:
                url = urlsplit(self.path)
                query = parse_qs(url.query, keep_blank_values=True)
                self._record(url, query, None)
                if url.path != OBSERVATIONS_PATH:
                    self._send(404, {"error": f"unexpected GET {url.path}"})
                    return
                if "parseIoAsJson" in query:
                    self._send(400, {"error": "parseIoAsJson is no longer supported"})
                    return
                if fake.observations_status != 200:
                    self._send(fake.observations_status, {"error": "configured failure"})
                    return
                cursor = query.get("cursor", [None])[0]
                index = 0
                if cursor is not None:
                    if not cursor.startswith("p") or not cursor[1:].isdigit():
                        self._send(400, {"error": "invalid cursor"})
                        return
                    index = int(cursor[1:])
                if index >= len(fake._pages):
                    self._send(400, {"error": "cursor out of range"})
                    return
                meta = {"cursor": f"p{index + 1}"} if index + 1 < len(fake._pages) else {}
                self._send(200, {"data": fake._pages[index], "meta": meta})

            def do_POST(self) -> None:
                url = urlsplit(self.path)
                query = parse_qs(url.query, keep_blank_values=True)
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw.decode("utf-8")) if raw else None
                except ValueError:
                    body = None
                self._record(url, query, body)
                if url.path != SCORES_PATH:
                    self._send(404, {"error": f"unexpected POST {url.path}"})
                    return
                if not isinstance(body, list):
                    self._send(400, {"error": "scores body must be an array"})
                    return
                fake.scores.extend(body)
                if fake.scores_status == 207:
                    rejected = [{"index": i} for i in range(len(body)) if not fake.reject_indexes or i in fake.reject_indexes]
                    accepted = [{"index": i} for i in range(len(body)) if {"index": i} not in rejected]
                    self._send(207, {"accepted": accepted, "rejected": rejected, "errors": []})
                    return
                self._send(202, {"message": "Accepted"})

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        self._server = server
        self.url = f"http://127.0.0.1:{server.server_address[1]}"
        self._thread = threading.Thread(target=server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        server, thread = self._server, self._thread
        self._server = None
        self._thread = None
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=5)

    def __enter__(self) -> "FakeLangfuse":
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()
