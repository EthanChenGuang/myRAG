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

VISIBLE_IT = (
    "Il documento descrive le fasi principali del progetto.",
    "Ogni fase ha un responsabile e una data di consegna.",
    "Il riepilogo viene aggiornato alla fine di ogni mese.",
)
VISIBLE_ZH = (
    "本文件介绍项目的主要阶段和每个阶段的目标。",
    "每个阶段都有负责人和计划完成日期。",
    "进度在每周例会开始时汇报一次。",
)

HIDDEN_SENTENCE = {
    "hidden-run": "This sentence is marked as vanished text in its run.",
    "white-text": "This sentence is written in white on a white page.",
    "tiny-size": "Questa frase usa un carattere troppo piccolo da leggere.",
    "comments": "这条批注只出现在审阅窗格里。",
    "tracked-deletion": "This sentence was removed with change tracking on.",
    "vanish-by-style": "This sentence is hidden by a style it inherits from.",
}
# In vanish-by-style.docx this run sits in the vanishing style but turns vanish off itself, so it is visible.
UNVANISHED_IN_STYLE = "This sentence turns the inherited hidden setting off."

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


def package(
    body: str,
    styles: str = "",
    comments: list[str] | None = None,
    extra_relationships: str = "",
) -> bytes:
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
        + extra_relationships
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


def white_text() -> bytes:
    body = (
        para(run(VISIBLE_EN[0]))
        + para(run(HIDDEN_SENTENCE["white-text"], '<w:color w:val="FFFFFF"/>'))
        + para(run(VISIBLE_EN[1]))
        + para(run(VISIBLE_EN[2]))
    )
    return package(body)


def tiny_size() -> bytes:
    body = (
        para(run(VISIBLE_IT[0]))
        + para(run(VISIBLE_IT[1]), run(" " + HIDDEN_SENTENCE["tiny-size"], '<w:sz w:val="2"/><w:szCs w:val="2"/>'))
        + para(run(VISIBLE_IT[2]))
    )
    return package(body)


def with_comments() -> bytes:
    body = (
        para(
            '<w:commentRangeStart w:id="0"/>',
            run(VISIBLE_ZH[0]),
            '<w:commentRangeEnd w:id="0"/>',
            '<w:r><w:commentReference w:id="0"/></w:r>',
        )
        + para(run(VISIBLE_ZH[1]))
        + para(run(VISIBLE_ZH[2]))
    )
    return package(body, comments=[HIDDEN_SENTENCE["comments"]])


def tracked_deletion() -> bytes:
    deleted = (
        '<w:del w:id="1" w:author="Editor">'
        f'<w:r><w:delText xml:space="preserve">{escape(HIDDEN_SENTENCE["tracked-deletion"])}</w:delText></w:r>'
        "</w:del>"
    )
    inserted = f'<w:ins w:id="2" w:author="Editor">{run(VISIBLE_EN[1])}</w:ins>'
    body = para(run(VISIBLE_EN[0])) + para(deleted, inserted) + para(run(VISIBLE_EN[2]))
    return package(body)


def vanish_by_style() -> bytes:
    styles = (
        '<w:style w:type="paragraph" w:styleId="NoteBase"><w:name w:val="Note Base"/><w:basedOn w:val="Normal"/>'
        "<w:rPr><w:vanish/></w:rPr></w:style>"
        '<w:style w:type="paragraph" w:styleId="NoteText"><w:name w:val="Note Text"/><w:basedOn w:val="NoteBase"/>'
        '<w:rPr><w:i/></w:rPr></w:style>'
    )
    note = '<w:pStyle w:val="NoteText"/>'
    body = (
        para(run(VISIBLE_EN[0]))
        + para(run(HIDDEN_SENTENCE["vanish-by-style"]), ppr=note)
        + para(run(UNVANISHED_IN_STYLE, '<w:vanish w:val="0"/>'), ppr=note)
        + para(run(VISIBLE_EN[1]))
        + para(run(VISIBLE_EN[2]))
    )
    return package(body, styles=styles)


def clean_plain() -> bytes:
    return package(visible(*VISIBLE_EN))


def clean_styled() -> bytes:
    styles = (
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>'
        '<w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="32"/></w:rPr></w:style>'
        '<w:style w:type="paragraph" w:styleId="SmallPrint"><w:name w:val="Small Print"/><w:basedOn w:val="Normal"/>'
        '<w:rPr><w:color w:val="595959"/><w:sz w:val="16"/></w:rPr></w:style>'
        '<w:style w:type="character" w:styleId="Accent"><w:name w:val="Accent"/>'
        '<w:rPr><w:color w:val="C00000"/></w:rPr></w:style>'
        '<w:style w:type="table" w:styleId="BandedTable"><w:name w:val="Banded Table"/>'
        '<w:tblStylePr w:type="firstRow"><w:rPr><w:color w:val="FFFFFF"/></w:rPr>'
        '<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="1F3864"/></w:tcPr></w:tblStylePr></w:style>'
    )
    white_bold = '<w:b/><w:color w:val="FFFFFF"/>'
    header_cell = (
        '<w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="1F3864"/></w:tcPr>'
        f"{para(run('Item', white_bold))}</w:tc>"
    )
    # No direct cell shading: the dark fill comes from the table style's first-row formatting.
    styled_header = f"<w:tc>{para(run('Owner', white_bold))}</w:tc>"
    body_cell = f"<w:tc>{para(run('Weekly summary'))}</w:tc><w:tc>{para(run('Team lead'))}</w:tc>"
    table = (
        '<w:tbl><w:tblPr><w:tblStyle w:val="BandedTable"/></w:tblPr>'
        f"<w:tr>{header_cell}{styled_header}</w:tr><w:tr>{body_cell}</w:tr></w:tbl>"
    )
    body = (
        para(run("Project overview"), ppr='<w:pStyle w:val="Heading1"/>')
        + para(run(VISIBLE_EN[0]), run(" Key point.", '<w:rStyle w:val="Accent"/>'))
        + table
        + para(run(VISIBLE_EN[1]), ppr='<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>')
        + para(run(VISIBLE_EN[2]), run("1", '<w:vertAlign w:val="superscript"/><w:sz w:val="14"/>'))
        + para(run("Prepared for internal planning only."), ppr='<w:pStyle w:val="SmallPrint"/>')
        + para(run("Light text on a dark band.", '<w:color w:val="FFFFFF"/><w:shd w:val="clear" w:color="auto" w:fill="333333"/>'))
        + para(run("Marked text.", '<w:highlight w:val="yellow"/>'))
    )
    external = (
        '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
        'Target="https://example.org/reference/overview" TargetMode="External"/>'
    )
    return package(body, styles=styles, extra_relationships=external)


def clean_empty() -> bytes:
    return package("<w:p/>")


HIDDEN_FIXTURES = {
    "hidden-run.docx": (hidden_run, "vanished_run"),
    "white-text.docx": (white_text, "color_near_background"),
    "tiny-size.docx": (tiny_size, "font_too_small"),
    "comments.docx": (with_comments, "comment"),
    "tracked-deletion.docx": (tracked_deletion, "tracked_deletion"),
    "vanish-by-style.docx": (vanish_by_style, "vanished_run"),
}
CLEAN_FIXTURES = {
    "clean-plain.docx": clean_plain,
    "clean-styled.docx": clean_styled,
    "clean-empty.docx": clean_empty,
}


# Hostile packages for the safety tests; built in memory by the tests, never written to the fixture folder.
def too_many_members(count: int) -> bytes:
    members = [(f"word/media/part{index:05d}.xml", b"<a/>") for index in range(count)]
    return write_zip([("word/document.xml", document_xml(para(run(VISIBLE_EN[0]))).encode("utf-8")), *members])


def oversized_member(size: int) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        info = zipfile.ZipInfo("word/document.xml", date_time=FIXED_DATE)
        info.compress_type = zipfile.ZIP_DEFLATED
        with archive.open(info, "w") as handle:
            block = b" " * (1 << 20)
            for _ in range(size // len(block)):
                handle.write(block)
    return buffer.getvalue()


def oversized_package(members: int, size: int) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for index in range(members):
            info = zipfile.ZipInfo(f"word/media/blob{index}.bin", date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            with archive.open(info, "w") as handle:
                block = b"\0" * (1 << 20)
                for _ in range(size // len(block)):
                    handle.write(block)
    return buffer.getvalue()


def entity_expansion() -> bytes:
    entities = '<!ENTITY a "aaaaaaaaaa">' + "".join(
        f'<!ENTITY {chr(98 + level)} "{("&" + chr(97 + level) + ";") * 10}">' for level in range(8)
    )
    document = (
        f'{XML_DECL}<!DOCTYPE w:document [{entities}]>'
        f'<w:document xmlns:w="{W_NS}"><w:body><w:p><w:r><w:t>&i;</w:t></w:r></w:p></w:body></w:document>'
    )
    return _with_document(document)


def _with_document(document: str) -> bytes:
    return write_zip(
        [
            ("[Content_Types].xml", f'{XML_DECL}<Types xmlns="{CT_NS}"/>'.encode()),
            ("word/document.xml", document.encode("utf-8")),
        ]
    )


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
