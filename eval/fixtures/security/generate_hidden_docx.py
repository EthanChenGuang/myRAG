"""Deterministic generator for the hidden-text Word fixtures (plan 03.2-36, D-33, D-46, D-52).

Run from the repository root:

    python3 eval/fixtures/security/generate_hidden_docx.py --out eval/fixtures/security/docx

Each .docx is a minimal WordprocessingML package written with the standard library only: members in a fixed
order, stored (not deflated, so the bytes do not depend on the zlib build), every timestamp 1980-01-01 00:00:00
and fixed attributes. The same code gives the same bytes on every machine. All text is neutral synthetic prose.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

FIXED_DATE = (1980, 1, 1, 0, 0, 0)
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
STYLES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
COMMENTS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
MAIN_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
STYLES_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"
COMMENTS_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"
XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

VISIBLE_EN = (
    "The quarterly review lists three open items for the team.",
    "Each item has an owner and a target date in the next cycle.",
    "Progress is reported at the start of every weekly meeting.",
)

HIDDEN_SENTENCE = {
    "hidden-run": "This sentence is marked as vanished text in its run.",
}

BASE_STYLES = (
    '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault>'
    "<w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>"
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
)


def run(text: str, rpr: str = "") -> str:
    props = f"<w:rPr>{rpr}</w:rPr>" if rpr else ""
    return f'<w:r>{props}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def para(*runs: str, ppr: str = "") -> str:
    props = f"<w:pPr>{ppr}</w:pPr>" if ppr else ""
    return f"<w:p>{props}{''.join(runs)}</w:p>"


def visible(*lines: str) -> str:
    return "".join(para(run(line)) for line in lines)


def document_xml(body: str) -> str:
    return f'{XML_DECL}<w:document xmlns:w="{W_NS}" xmlns:r="{R_NS}"><w:body>{body}<w:sectPr/></w:body></w:document>'


def styles_xml(styles: str = "") -> str:
    return f'{XML_DECL}<w:styles xmlns:w="{W_NS}">{BASE_STYLES}{styles}</w:styles>'


def comments_xml(comments: list[str]) -> str:
    items = "".join(
        f'<w:comment w:id="{index}" w:author="Reviewer" w:initials="R">{para(run(text))}</w:comment>'
        for index, text in enumerate(comments)
    )
    return f'{XML_DECL}<w:comments xmlns:w="{W_NS}">{items}</w:comments>'


def write_zip(members: list[tuple[str, bytes]]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in members:
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    return buffer.getvalue()


def package(body: str, styles: str = "", comments: list[str] | None = None) -> bytes:
    overrides = [("/word/document.xml", MAIN_CT), ("/word/styles.xml", STYLES_CT)]
    relationships = [("rId1", STYLES_REL, "styles.xml")]
    if comments is not None:
        overrides.append(("/word/comments.xml", COMMENTS_CT))
        relationships.append(("rId2", COMMENTS_REL, "comments.xml"))
    content_types = (
        f'{XML_DECL}<Types xmlns="{CT_NS}">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        + "".join(f'<Override PartName="{part}" ContentType="{kind}"/>' for part, kind in overrides)
        + "</Types>"
    )
    root_rels = f'{XML_DECL}<Relationships xmlns="{REL_NS}"><Relationship Id="rId1" Type="{DOC_REL}" Target="word/document.xml"/></Relationships>'
    document_rels = (
        f'{XML_DECL}<Relationships xmlns="{REL_NS}">'
        + "".join(f'<Relationship Id="{rid}" Type="{kind}" Target="{target}"/>' for rid, kind, target in relationships)
        + "</Relationships>"
    )
    members = [
        ("[Content_Types].xml", content_types),
        ("_rels/.rels", root_rels),
        ("word/document.xml", document_xml(body)),
        ("word/_rels/document.xml.rels", document_rels),
        ("word/styles.xml", styles_xml(styles)),
    ]
    if comments is not None:
        members.append(("word/comments.xml", comments_xml(comments)))
    return write_zip([(name, text.encode("utf-8")) for name, text in members])


def hidden_run() -> bytes:
    body = (
        para(run(VISIBLE_EN[0]))
        + para(run(VISIBLE_EN[1]), run(" " + HIDDEN_SENTENCE["hidden-run"], "<w:vanish/>"))
        + para(run(VISIBLE_EN[2]))
    )
    return package(body)


def clean_plain() -> bytes:
    return package(visible(*VISIBLE_EN))


HIDDEN_FIXTURES = {
    "hidden-run.docx": (hidden_run, "vanished_run"),
}
CLEAN_FIXTURES = {
    "clean-plain.docx": clean_plain,
}


def build_fixtures() -> dict[str, bytes]:
    built = {name: build() for name, (build, _) in HIDDEN_FIXTURES.items()}
    built.update({name: build() for name, build in CLEAN_FIXTURES.items()})
    return dict(sorted(built.items()))


def manifest(built: dict[str, bytes]) -> dict:
    return {
        "generator": "eval/fixtures/security/generate_hidden_docx.py",
        "fixtures": {
            name: {
                "sha256": hashlib.sha256(data).hexdigest(),
                "expected": "hidden_found" if name in HIDDEN_FIXTURES else "clean",
                "reason": HIDDEN_FIXTURES[name][1] if name in HIDDEN_FIXTURES else None,
                "hidden_text": HIDDEN_SENTENCE.get(name.removesuffix(".docx")),
            }
            for name, data in built.items()
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "docx")
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    built = build_fixtures()
    for name, data in built.items():
        (args.out / name).write_bytes(data)
    (args.out / "manifest.json").write_text(
        json.dumps(manifest(built), ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
