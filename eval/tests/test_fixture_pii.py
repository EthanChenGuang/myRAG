import re

from rag_eval.paths import REPO_ROOT

FIXTURES = REPO_ROOT / "eval/fixtures"
ALLOWED_EMAIL_DOMAINS = {"example.com", "example.org", "example.net"}

LOCAL_PHONE_RE = re.compile(r"(?<![\w-])(\d{3})-(\d{4})(?!\d)")
NANP_PHONE_RE = re.compile(r"(?<!\d)(?:\+?1[ .-]?)?\(?(\d{3})\)?[ .-](\d{3})[ .-](\d{4})(?!\d)")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")
CN_MOBILE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
IT_PHONE_RE = re.compile(r"\+39|(?<!\d)0039(?!\d)|(?<!\d)3\d{2}[ .-]?\d{3}[ .-]?\d{3,4}(?!\d)")


def _is_reserved_local(exchange: str, line: str) -> bool:
    return exchange == "555" and line.startswith("01")


def phone_violations(text: str) -> list[str]:
    found: list[str] = []
    for match in NANP_PHONE_RE.finditer(text):
        area, exchange, line = match.groups()
        if not _is_reserved_local(exchange, line):
            found.append(match.group(0))
    for match in LOCAL_PHONE_RE.finditer(text):
        exchange, line = match.groups()
        if not _is_reserved_local(exchange, line):
            found.append(match.group(0))
    found += [m.group(0) for m in CN_MOBILE_RE.finditer(text)]
    found += [m.group(0) for m in IT_PHONE_RE.finditer(text)]
    return found


def email_violations(text: str) -> list[str]:
    return [m.group(0) for m in EMAIL_RE.finditer(text) if m.group(1).lower() not in ALLOWED_EMAIL_DOMAINS]


INGEST_FIXTURES = FIXTURES / "ingest"
PARSE_FIXTURES = FIXTURES / "parse"
INGEST_FILE_COUNT = 54


def _ingest_files():
    """Text of the typed ingestion fixtures: the specs every PDF is built from, the Markdown for the text path,
    the manifest and the recorded parse results and Docling JSON (the PDFs and pictures are binary renderings of these)."""
    return [
        INGEST_FIXTURES / "specs.py",
        *sorted((INGEST_FIXTURES / "text").glob("*.md")),
        INGEST_FIXTURES / "manifest.json",
        *sorted((INGEST_FIXTURES / "recorded").glob("*.json")),
    ]


def _parse_files():
    return [
        PARSE_FIXTURES / "parse_specs.py",
        PARSE_FIXTURES / "parse_expected.py",
        PARSE_FIXTURES / "generate_parse.py",
        PARSE_FIXTURES / "build_recorded.py",
        *sorted((PARSE_FIXTURES / "expected").glob("*.json")),
    ]


def _fixture_files():
    corpus = sorted((FIXTURES / "corpus").rglob("*.md")) + [FIXTURES / "golden.jsonl", FIXTURES / "split-manifest.json"]
    # 22 documents, golden.jsonl and the split manifest, plus the 22 Phase 4.2 files of plan 04.2-37 (templates included).
    assert len(corpus) == 24 + 22
    ingest = _ingest_files()
    assert len(ingest) == INGEST_FILE_COUNT
    parse_files = _parse_files()
    assert len(parse_files) >= 13
    return corpus + ingest + parse_files


def test_fixture_text_has_only_reserved_phone_numbers():
    for path in _fixture_files():
        assert phone_violations(path.read_text(encoding="utf-8")) == [], str(path)


def test_fixture_text_has_only_example_email_domains():
    emails = 0
    for path in _fixture_files():
        text = path.read_text(encoding="utf-8")
        assert email_violations(text) == [], str(path)
        emails += len(EMAIL_RE.findall(text))
    assert emails > 0


def test_corpus_still_contains_reserved_phone_numbers_the_scanner_accepts():
    text = "\n".join(p.read_text(encoding="utf-8") for p in (FIXTURES / "corpus").rglob("*.md"))
    assert LOCAL_PHONE_RE.findall(text)
    assert phone_violations(text) == []


def test_scanner_flags_real_looking_numbers_and_addresses():
    assert phone_violations("call 555-0142") == []
    assert phone_violations("call 555-0299") != []
    assert phone_violations("call 212-867-5309") != []
    assert phone_violations("call (415) 555-0123") == []
    assert phone_violations("call 13812345678") != []
    assert phone_violations("chiama +39 06 1234 5678") != []
    assert phone_violations("chiama 347 1234567") != []
    assert phone_violations("SKU LV-77-0192 and order 2024-01-15") == []
    assert email_violations("write to a@example.com or b@example.org or c@example.net") == []
    assert email_violations("write to someone@gmail.com") == ["someone@gmail.com"]
