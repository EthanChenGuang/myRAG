import json
import subprocess
import sys
from pathlib import Path

from rag_eval.corpus import load_corpus, main
from rag_eval.paths import REPO_ROOT

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
