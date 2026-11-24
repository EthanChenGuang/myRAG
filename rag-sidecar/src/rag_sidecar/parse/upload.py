from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import IO

from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import MultipartParser, parse_options_header

REQUEST_PART_MAX_BYTES = 64 * 1024
BODY_ALLOWANCE_BYTES = 1024 * 1024
FILE_PART = b"file"
REQUEST_PART = b"request"


class UploadTooLarge(Exception):
    pass


class MalformedUpload(Exception):
    pass


@dataclass(frozen=True)
class ParsedUpload:
    request_json: bytes | None
    file_bytes: int


class _PartCollector:
    def __init__(self, destination: Path, max_file_bytes: int) -> None:
        self._destination = destination
        self._max_file_bytes = max_file_bytes
        self._headers: dict[bytes, bytes] = {}
        self._field = bytearray()
        self._value = bytearray()
        self._target: bytes | None = None
        self._handle: IO[bytes] | None = None
        self._file_seen = False
        self._request: bytearray | None = None
        self.file_bytes = 0

    @property
    def request_json(self) -> bytes | None:
        return bytes(self._request) if self._request is not None else None

    def callbacks(self) -> dict[str, object]:
        return {
            "on_part_begin": self._part_begin,
            "on_header_field": lambda data, start, end: self._field.extend(data[start:end]),
            "on_header_value": lambda data, start, end: self._value.extend(data[start:end]),
            "on_header_end": self._header_end,
            "on_headers_finished": self._headers_finished,
            "on_part_data": self._part_data,
            "on_part_end": self.close,
        }

    def close(self) -> None:
        if self._handle is not None:
            self._handle.close()
            self._handle = None
        self._target = None

    def _part_begin(self) -> None:
        self._headers = {}
        self._field = bytearray()
        self._value = bytearray()
        self._target = None

    def _header_end(self) -> None:
        self._headers[bytes(self._field).lower()] = bytes(self._value)
        self._field = bytearray()
        self._value = bytearray()

    def _headers_finished(self) -> None:
        _, params = parse_options_header(self._headers.get(b"content-disposition", b""))
        name = params.get(b"name")
        if name == FILE_PART:
            if self._file_seen:
                raise MalformedUpload("duplicate file part")
            self._file_seen = True
            self._target = FILE_PART
            self._handle = self._destination.open("wb")
        elif name == REQUEST_PART:
            if self._request is not None:
                raise MalformedUpload("duplicate request part")
            self._target = REQUEST_PART
            self._request = bytearray()

    def _part_data(self, data: bytes, start: int, end: int) -> None:
        size = end - start
        if self._target == FILE_PART and self._handle is not None:
            self.file_bytes += size
            if self.file_bytes > self._max_file_bytes:
                raise UploadTooLarge
            self._handle.write(data[start:end])
        elif self._target == REQUEST_PART and self._request is not None:
            if len(self._request) + size > REQUEST_PART_MAX_BYTES:
                raise MalformedUpload("request part too large")
            self._request.extend(data[start:end])


async def read_upload(
    stream: AsyncIterator[bytes], content_type: str, destination: Path, max_file_bytes: int
) -> ParsedUpload:
    media_type, params = parse_options_header(content_type.encode("latin-1", errors="replace"))
    boundary = params.get(b"boundary")
    if media_type != b"multipart/form-data" or not boundary:
        raise MalformedUpload("expected multipart/form-data")

    collector = _PartCollector(destination, max_file_bytes)
    parser = MultipartParser(boundary, collector.callbacks())
    body_limit = max_file_bytes + REQUEST_PART_MAX_BYTES + BODY_ALLOWANCE_BYTES
    received = 0
    try:
        async for chunk in stream:
            received += len(chunk)
            if received > body_limit:
                raise UploadTooLarge
            parser.write(chunk)
        parser.finalize()
    except MultipartParseError as error:
        raise MalformedUpload("malformed multipart body") from error
    finally:
        collector.close()
    return ParsedUpload(request_json=collector.request_json, file_bytes=collector.file_bytes)
