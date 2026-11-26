"""Deterministic generator for the link-check fixtures (plan 03.2-39, D-35, D-46).

Run from the repository root:

    python3 eval/fixtures/security/generate_link_docs.py --out eval/fixtures/security/links

Bad fixtures carry one target outside the allowlist each: a URL, a bare domain, an e-mail address, and a PDF whose visible text is
clean but whose link annotation points outside. Clean fixtures in zh, en and it carry file names, version numbers, section numbers,
abbreviations, an allowlisted URL and an address at the allowlisted domain; none of them may be quarantined. The allowlist used by the
tests is `example.com`. The PDFs are written by hand with the standard library only (no dates, no document id), so the same code gives
the same bytes everywhere. All text is neutral synthetic prose.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ALLOWLIST = "example.com"

CLEAN_EN = """# Module Notes

The attached report.pdf and notes.docx describe release v2.0 of the blue module.
Section 3.2.1 lists the steps, e.g. joining the second relay; see also Art. 5 of the handbook, i.e. the short form.
The full guide is at https://docs.example.com/guide and questions go to team@example.com.
Version 1.4.2 replaced 1.4.1, and file data.json holds the counters (No. 7, ca. 12 items, etc.).
"""

CLEAN_IT = """# Note sul modulo

Il file report.pdf descrive la versione v2.0 del modulo blu, cfr. il capitolo 3.2.1.
Secondo l'Art. 5 del manuale, ad es. il secondo relè si collega dopo la luce ambra, ecc.
La guida completa si trova su https://docs.example.com/guida e le domande vanno a team@example.com.
Il paragrafo 4.1 e la tabella n. 3 riassumono i contatori (sig. Rossi, pag. 12).
"""

CLEAN_ZH = """# 模块说明

附件 report.pdf 介绍了蓝色模块 v2.0 版本的主要步骤，详见第3.2条和第3.2.1节。
例如 e.g. 第二个继电器在琥珀灯常亮后接入；参见手册 Art. 5，即 i.e. 简要说明。
完整指南见 https://docs.example.com/zh/guide ，问题请发送至 team@example.com 。
计数器保存在 data.json 文件中，版本 1.4.2 取代了 1.4.1。
"""

BAD_URL = """# Relay Notes

The blue module joins the second relay after the amber light turns steady.
Further steps are described at https://phish.example.net/login before the night cycle.
"""

BAD_DOMAIN = """# Relay Notes

The panel stays closed during the night cycle and opens again at the first bell.
Updated counters are published on phish-example.net every week.
"""

BAD_EMAIL = """# Note sul modulo

Il pannello resta chiuso durante il ciclo notturno e si riapre alla prima campana.
Per le domande scrivere a supporto@outside-example.net entro la fine del mese.
"""

PDF_VISIBLE = (
    "The quarterly review lists three open items for the team.",
    "Each item has an owner and a target date in the next cycle.",
    "The reference overview is linked from this page.",
)


def _pdf_string(text: str) -> bytes:
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return f"({escaped})".encode("latin-1")


def build_link_pdf(lines: tuple[str, ...], uri: str) -> bytes:
    """One A4 page with Helvetica text and one /Link annotation whose /URI action points at `uri`."""
    ops = [b"BT", b"/F1 12 Tf", b"0 0 0 rg"]
    y = 780
    for line in lines:
        ops.append(f"1 0 0 1 72 {y} Tm".encode())
        ops.append(_pdf_string(line) + b" Tj")
        y -= 20
    ops.append(b"ET")
    content = b"\n".join(ops) + b"\n"
    rect_y = 780 - 20 * (len(lines) - 1)
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
        b"<< /Type /Annot /Subtype /Link /Rect [72 "
        + str(rect_y - 4).encode()
        + b" 400 "
        + str(rect_y + 14).encode()
        + b"] /Border [0 0 0] /A << /S /URI /URI "
        + _pdf_string(uri)
        + b" >> >>",
    ]
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def fixtures() -> dict[str, dict]:
    def text_entry(body: str, language: str, expected: str, targets: list[dict]) -> dict:
        return {"bytes": body.encode("utf-8"), "mime": "text/markdown", "language": language, "expected": expected, "targets": targets}

    def pdf_entry(uri: str, expected: str, targets: list[dict]) -> dict:
        return {
            "bytes": build_link_pdf(PDF_VISIBLE, uri),
            "mime": "application/pdf",
            "language": "en",
            "expected": expected,
            "targets": targets,
            "visible_text": "\n".join(PDF_VISIBLE) + "\n",
            "annotation_targets": [uri],
        }

    return {
        "bad-url.md": text_entry(BAD_URL, "en", "quarantined", [{"kind": "url", "target": "https://phish.example.net/login"}]),
        "bad-domain.md": text_entry(BAD_DOMAIN, "en", "quarantined", [{"kind": "domain", "target": "phish-example.net"}]),
        "bad-email.md": text_entry(BAD_EMAIL, "it", "quarantined", [{"kind": "email", "target": "supporto@outside-example.net"}]),
        "bad-annotation.pdf": pdf_entry(
            "https://outside.example.net/reference/overview", "quarantined", [{"kind": "annotation", "target": "https://outside.example.net/reference/overview"}]
        ),
        "clean-en.md": text_entry(CLEAN_EN, "en", "ready", []),
        "clean-it.md": text_entry(CLEAN_IT, "it", "ready", []),
        "clean-zh.md": text_entry(CLEAN_ZH, "zh", "ready", []),
        "clean-annotation.pdf": pdf_entry("https://docs.example.com/reference/overview", "ready", []),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("eval/fixtures/security/links"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    manifest: dict = {"schema_version": 1, "allowlist": ALLOWLIST, "fixtures": {}}
    for name, entry in fixtures().items():
        data = entry.pop("bytes")
        (args.out / name).write_bytes(data)
        manifest["fixtures"][name] = {**entry, "sha256": hashlib.sha256(data).hexdigest()}
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
