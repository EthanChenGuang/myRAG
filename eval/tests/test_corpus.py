import json
import subprocess
import sys
from pathlib import Path

import pytest

from rag_eval.corpus import load_corpus, main
from rag_eval.paths import REPO_ROOT

# Re-recorded by plan 05.3-15 (six new corpus documents).
COMMITTED_CORPUS_SHA256 = "24a83817b38689cc3b637a0a78d3dd736f8e0c2a9bca742ff4ae8a8157756154"
META = '<!-- fixture-meta {"filename": "Policy Handbook.pdf", "image_url": "https://example.test/a.png"} -->'


def _write(root: Path, relpath: str, text: str) -> None:
    target = root / relpath
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(text.encode("utf-8"))


def test_meta_header_chunks_sections_and_stored_content(tmp_path: Path):
    _write(
        tmp_path,
        "en/policy.en.md",
        f"{META}\n"
        "## Alpha\n\nFirst body.\n\n<!-- chunk -->\n\n"
        "### Beta  \n\nSecond body.\n\n<!-- chunk -->\n\n"
        "\n  \n<!-- chunk -->\n"
        "no heading here\n",
    )
    (doc,) = load_corpus(tmp_path)
    assert doc.relpath == "en/policy.en.md"
    assert doc.language == "en"
    assert doc.filename == "Policy Handbook.pdf"
    assert doc.image_url == "https://example.test/a.png"
    assert [c.text for c in doc.chunks] == ["## Alpha\n\nFirst body.", "### Beta  \n\nSecond body.", "no heading here"]
    assert [c.section for c in doc.chunks] == ["Alpha", "Beta", ""]
    assert [c.index for c in doc.chunks] == [0, 1, 2]
    assert doc.chunks[0].stored == "Document: Policy Handbook.pdf. Chunk 1 of 3. Content: ## Alpha\n\nFirst body."
    assert doc.chunks[2].stored == "Document: Policy Handbook.pdf. Chunk 3 of 3. Content: no heading here"
    assert doc.content == "\n\n".join(c.text for c in doc.chunks)


def test_filename_defaults_to_basename_and_marker_must_be_an_exact_line(tmp_path: Path):
    _write(tmp_path, "it/guida.it.md", "## Uno\n\ntesto <!-- chunk --> ancora\n<!-- chunk --> \n\n<!-- chunk -->\n## Due\n")
    (doc,) = load_corpus(tmp_path)
    assert doc.filename == "guida.it.md"
    assert doc.image_url is None
    assert [c.text for c in doc.chunks] == ["## Uno\n\ntesto <!-- chunk --> ancora\n<!-- chunk -->", "## Due"]


def test_crlf_is_normalized_and_chinese_text_is_kept(tmp_path: Path):
    _write(tmp_path, "zh/退款.zh.md", "## 退款\r\n\r\n七天内无理由退货。\r\n<!-- chunk -->\r\n## 例外\r\n\r\n定制商品不退。\r\n")
    (doc,) = load_corpus(tmp_path)
    assert [c.text for c in doc.chunks] == ["## 退款\n\n七天内无理由退货。", "## 例外\n\n定制商品不退。"]
    assert doc.chunks[1].stored == "Document: 退款.zh.md. Chunk 2 of 2. Content: ## 例外\n\n定制商品不退。"


def test_documents_are_sorted_posix_relpaths_and_only_known_languages_and_md(tmp_path: Path):
    _write(tmp_path, "zh/b.zh.md", "## B\n")
    _write(tmp_path, "en/z.en.md", "## Z\n")
    _write(tmp_path, "en/a.en.md", "## A\n")
    _write(tmp_path, "it/m.it.md", "## M\n")
    _write(tmp_path, "en/notes.txt", "ignored")
    _write(tmp_path, "fr/x.fr.md", "## X\n")
    assert [d.relpath for d in load_corpus(tmp_path)] == ["en/a.en.md", "en/z.en.md", "it/m.it.md", "zh/b.zh.md"]


def test_missing_language_directory_is_skipped(tmp_path: Path):
    _write(tmp_path, "en/a.en.md", "## A\n")
    assert [d.language for d in load_corpus(tmp_path)] == ["en"]


def test_cli_dump_prints_the_structure_as_json(tmp_path: Path, capsys):
    _write(tmp_path, "en/policy.en.md", f"{META}\n## Alpha\n\nFirst body.\n<!-- chunk -->\n## Beta\n\nSecond.\n")
    assert main(["dump", str(tmp_path)]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload == [
        {
            "relpath": "en/policy.en.md",
            "filename": "Policy Handbook.pdf",
            "language": "en",
            "doc_type": "general",
            "chunks": [
                {
                    "index": 0,
                    "section": "Alpha",
                    "text": "## Alpha\n\nFirst body.",
                    "stored": "Document: Policy Handbook.pdf. Chunk 1 of 2. Content: ## Alpha\n\nFirst body.",
                },
                {
                    "index": 1,
                    "section": "Beta",
                    "text": "## Beta\n\nSecond.",
                    "stored": "Document: Policy Handbook.pdf. Chunk 2 of 2. Content: ## Beta\n\nSecond.",
                },
            ],
        }
    ]


def test_doc_type_defaults_to_general_when_missing(tmp_path: Path):
    _write(tmp_path, "en/a.en.md", "## A\n\nBody.\n")
    (doc,) = load_corpus(tmp_path)
    assert doc.doc_type == "general"


def test_invalid_doc_type_fails_loading(tmp_path: Path):
    _write(tmp_path, "en/a.en.md", '<!-- fixture-meta {"doc_type": "invalid_kind"} -->\n## A\n')
    with pytest.raises(ValueError, match="invalid doc_type"):
        load_corpus(tmp_path)


def test_doc_type_from_meta_is_returned(tmp_path: Path):
    _write(tmp_path, "en/a.en.md", '<!-- fixture-meta {"doc_type": "product_technical"} -->\n## A\n')
    (doc,) = load_corpus(tmp_path)
    assert doc.doc_type == "product_technical"


def test_cli_module_entry_point_dumps_the_committed_corpus():
    result = subprocess.run(
        [sys.executable, "-m", "rag_eval.corpus", "dump", "eval/fixtures/corpus"],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT / "eval",
        check=False,
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload and all(doc["chunks"] for doc in payload)
    assert [d["relpath"] for d in payload] == sorted(d["relpath"] for d in payload)


TEMPLATE_META = {
    "doc_type": "product_technical",
    "generate": {
        "count": 30,
        "name": "copy-{n}.en.md",
        "substitutions": [["lantern", "lantern"], ["lantern", "beacon"], ["lantern", "signal"]],
        "template_id": "T",
    },
}
TEMPLATE_BODY = "## Shared notice\n\nThe lantern panel opens after the second chime.\n<!-- chunk -->\n## Closing\n\nThe lantern stays lit.\n"


def _template(meta: dict | None = None, body: str = TEMPLATE_BODY) -> str:
    return f"<!-- fixture-meta {json.dumps(meta or TEMPLATE_META)} -->\n{body}"


def test_generate_block_expands_into_named_copies_and_hides_the_template(tmp_path: Path):
    _write(tmp_path, "en/template.en.md", _template())
    _write(tmp_path, "en/other.en.md", "## Other\n\nUnrelated body.\n")
    docs = load_corpus(tmp_path)
    copies = [d for d in docs if d.fixture_dup_template == "T"]
    assert len(copies) == 30
    assert "en/template.en.md" not in [d.relpath for d in docs]
    assert [d.relpath for d in docs] == sorted(d.relpath for d in docs)
    assert [d.filename for d in copies] == [f"copy-{i:02d}.en.md" for i in range(1, 31)]
    other = next(d for d in docs if d.relpath == "en/other.en.md")
    assert other.fixture_dup_template is None
    words = ["lantern", "beacon", "signal"]
    for i, doc in enumerate(copies):
        word = words[i % 3]
        assert doc.doc_type == "product_technical"
        assert doc.language == "en"
        assert [c.text for c in doc.chunks] == [
            f"## Shared notice\n\nThe {word} panel opens after the second chime.",
            f"## Closing\n\nThe {word} stays lit.",
            f"T-{i + 1:02d}",
        ]
        assert doc.chunks[0].stored == f"Document: {doc.filename}. Chunk 1 of 3. Content: {doc.chunks[0].text}"


def test_generate_index_width_follows_the_count(tmp_path: Path):
    meta = {"generate": {"count": 100, "name": "c{n}.it.md", "substitutions": [], "template_id": "W"}}
    _write(tmp_path, "it/t.it.md", _template(meta, "## Uno\n\nTesto.\n"))
    docs = load_corpus(tmp_path)
    assert [d.filename for d in docs][:2] == ["c001.it.md", "c002.it.md"]
    assert docs[-1].filename == "c100.it.md"
    assert docs[0].chunks[-1].text == "W-001"


@pytest.mark.parametrize(
    "generate",
    [
        {"count": 0, "name": "c{n}.md", "substitutions": [], "template_id": "T"},
        {"count": 101, "name": "c{n}.md", "substitutions": [], "template_id": "T"},
        {"count": 2.5, "name": "c{n}.md", "substitutions": [], "template_id": "T"},
        {"count": True, "name": "c{n}.md", "substitutions": [], "template_id": "T"},
        {"count": 2, "name": "c{n}.md", "substitutions": []},
        {"count": 2, "name": "c{n}.md", "substitutions": [], "template_id": ""},
        {"count": 2, "name": "c{n}.md", "substitutions": [], "template_id": "T", "extra": 1},
        {"count": 2, "name": "fixed.md", "substitutions": [], "template_id": "T"},
        {"count": 2, "name": "sub/c{n}.md", "substitutions": [], "template_id": "T"},
        {"count": 2, "name": "c{n}.md", "substitutions": [["", "x"]], "template_id": "T"},
        {"count": 2, "name": "c{n}.md", "substitutions": [["a"]], "template_id": "T"},
        {"count": 2, "name": "c{n}.md", "template_id": "T"},
        "not an object",
    ],
)
def test_malformed_generate_block_names_the_file(tmp_path: Path, generate):
    _write(tmp_path, "en/bad-template.en.md", _template({"generate": generate}))
    with pytest.raises(ValueError, match=r"invalid generate block in en/bad-template\.en\.md"):
        load_corpus(tmp_path)


def test_generated_name_colliding_with_a_committed_file_fails(tmp_path: Path):
    meta = {"generate": {"count": 2, "name": "c{n}.en.md", "substitutions": [], "template_id": "T"}}
    _write(tmp_path, "en/t.en.md", _template(meta))
    _write(tmp_path, "en/c01.en.md", "## C\n")
    with pytest.raises(ValueError, match="duplicate corpus document en/c01.en.md"):
        load_corpus(tmp_path)


def test_corpus_hash_covers_template_bytes_once(tmp_path: Path):
    from rag_eval.corpus import corpus_sha256

    _write(tmp_path, "en/other.en.md", "## Other\n\nUnrelated body.\n")
    without = corpus_sha256(tmp_path)
    _write(tmp_path, "en/template.en.md", _template())
    with_one = corpus_sha256(tmp_path)
    assert with_one != without

    import hashlib

    expected = hashlib.sha256()
    for relpath in ["en/other.en.md", "en/template.en.md"]:
        expected.update(relpath.encode("utf-8"))
        expected.update(b"\x00")
        expected.update((tmp_path / relpath).read_bytes())
    assert with_one == expected.hexdigest()

    second = dict(TEMPLATE_META, generate=dict(TEMPLATE_META["generate"], name="other-{n}.en.md", template_id="U"))
    _write(tmp_path, "en/template2.en.md", _template(second))
    assert corpus_sha256(tmp_path) not in {with_one, without}


def test_lineage_and_version_are_read_and_validated(tmp_path: Path):
    _write(tmp_path, "en/a-v1.en.md", '<!-- fixture-meta {"lineage": "L", "version": 1} -->\n## A\n\nOld.\n')
    _write(tmp_path, "en/a-v2.en.md", '<!-- fixture-meta {"lineage": "L", "version": 2} -->\n## A\n\nNew.\n')
    _write(tmp_path, "en/plain.en.md", "## P\n")
    docs = {d.relpath: d for d in load_corpus(tmp_path)}
    assert (docs["en/a-v1.en.md"].lineage, docs["en/a-v1.en.md"].version) == ("L", 1)
    assert (docs["en/a-v2.en.md"].lineage, docs["en/a-v2.en.md"].version) == ("L", 2)
    assert (docs["en/plain.en.md"].lineage, docs["en/plain.en.md"].version) == (None, None)


@pytest.mark.parametrize(
    "meta",
    [{"lineage": "L"}, {"version": 1}, {"lineage": "", "version": 1}, {"lineage": "L", "version": 0}, {"lineage": "L", "version": 1.5}],
)
def test_malformed_lineage_names_the_file(tmp_path: Path, meta):
    _write(tmp_path, "en/bad.en.md", f"<!-- fixture-meta {json.dumps(meta)} -->\n## A\n")
    with pytest.raises(ValueError, match=r"invalid lineage in en/bad\.en\.md"):
        load_corpus(tmp_path)


def test_duplicate_lineage_version_fails(tmp_path: Path):
    _write(tmp_path, "en/a.en.md", '<!-- fixture-meta {"lineage": "L", "version": 1} -->\n## A\n')
    _write(tmp_path, "en/b.en.md", '<!-- fixture-meta {"lineage": "L", "version": 1} -->\n## B\n')
    with pytest.raises(ValueError, match="duplicate lineage version L 1"):
        load_corpus(tmp_path)


def test_dump_carries_template_and_lineage_keys_only_when_set(tmp_path: Path, capsys):
    meta = {"generate": {"count": 1, "name": "c{n}.en.md", "substitutions": [], "template_id": "T"}}
    _write(tmp_path, "en/t.en.md", _template(meta))
    _write(tmp_path, "en/v.en.md", '<!-- fixture-meta {"lineage": "L", "version": 2} -->\n## V\n')
    _write(tmp_path, "en/z.en.md", "## Z\n")
    assert main(["dump", str(tmp_path)]) == 0
    payload = {d["relpath"]: d for d in json.loads(capsys.readouterr().out)}
    assert payload["en/c01.en.md"]["fixture_dup_template"] == "T"
    assert payload["en/v.en.md"]["lineage"] == "L" and payload["en/v.en.md"]["version"] == 2
    assert {"fixture_dup_template", "lineage", "version"}.isdisjoint(payload["en/z.en.md"])


def test_committed_corpus_hash_is_unchanged():
    from rag_eval.corpus import corpus_sha256

    assert corpus_sha256(REPO_ROOT / "eval/fixtures/corpus") == COMMITTED_CORPUS_SHA256
