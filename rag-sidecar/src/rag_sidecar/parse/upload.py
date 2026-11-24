from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

REQUEST_PART_MAX_BYTES = 64 * 1024
BODY_ALLOWANCE_BYTES = 1024 * 1024


class UploadTooLarge(Exception):
    pass


class MalformedUpload(Exception):
    pass


@dataclass(frozen=True)
class ParsedUpload:
    request_json: bytes | None
    file_bytes: int


async def read_upload(
    stream: AsyncIterator[bytes], content_type: str, destination: Path, max_file_bytes: int
) -> ParsedUpload:
    return ParsedUpload(request_json=None, file_bytes=0)
