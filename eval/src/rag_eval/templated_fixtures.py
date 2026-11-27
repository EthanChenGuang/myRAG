"""Loader of the templated collection of the ingest fixture mode (plan 03.3-20; D-36, TPL-09).

The fixture tenant's rule data lives under eval/fixtures/ingest/templated/ as five JSON files; the documents are the
`templated_fixtures` of eval/fixtures/ingest/manifest.json. `load_templated_fixtures()` returns both in the shape the TypeScript
twin (eval/harness/templated-fixtures.mts, `loadTemplatedFixtures`) returns; `python -m rag_eval.templated_fixtures dump` prints it
as sorted JSON for the parity test. Patterns are data here: nothing in this module compiles or runs one.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from rag_sidecar.contracts.templated import (
    AttributeHeaderTemplate,
    AttributeImportRow,
    AttributeSchema,
    TenantRulesFile,
)

from rag_eval.paths import REPO_ROOT

INGEST_DIR = Path("eval/fixtures/ingest")
DATA_DIR = INGEST_DIR / "templated"
SOURCE = "config_upload"
DATA_FILES = {
    "attribute_schema": "attribute-schema.json",
    "attributes": "attributes.json",
    "section_rules": "section-rules.json",
    "boilerplate_rules": "boilerplate-rules.json",
    "header_template": "header-template.json",
}


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def source_key(file_name: str) -> str:
    """The source key ingest gives a config upload in the root folder (buildSourceKey in src/lib/rag/ingest/identity.ts)."""
    return f"root/{file_name}"


def load_templated_data(root: Path = REPO_ROOT) -> dict[str, Any]:
    """The five data files, each validated against its generated contract and returned as written."""
    data = {key: _read_json(root / DATA_DIR / name) for key, name in DATA_FILES.items()}
    AttributeSchema.model_validate(data["attribute_schema"])
    for row in data["attributes"]["rows"]:
        AttributeImportRow.model_validate(row)
    TenantRulesFile.model_validate(data["section_rules"])
    TenantRulesFile.model_validate(data["boilerplate_rules"])
    AttributeHeaderTemplate.model_validate(data["header_template"])
    return data


def load_templated_fixtures(root: Path = REPO_ROOT) -> dict[str, Any]:
    """Every templated fixture with its source key, declared lines and attribute values, plus the five data files."""
    manifest = _read_json(root / INGEST_DIR / "manifest.json")
    data = load_templated_data(root)
    rows = {row["source_key"]: row for row in data["attributes"]["rows"]}
    fixtures = []
    for entry in manifest.get("templated_fixtures", []):
        file_name = Path(entry["path"]).name
        key = source_key(file_name)
        row = rows.get(key)
        if row is None:
            raise ValueError(f"{entry['id']}: no attribute row for {key}")
        fixtures.append(
            {
                "id": entry["id"],
                "language": entry["language"],
                "doc_type": entry["doc_type"],
                "file_name": file_name,
                "path": (INGEST_DIR / entry["path"]).as_posix(),
                "file_sha256": entry["file_sha256"],
                "source": SOURCE,
                "source_key": key,
                "templated": entry["expected"]["templated"],
                "attributes": row["attributes"],
            }
        )
    return {"fixtures": fixtures, "data": data}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["dump"])
    parser.parse_args(argv)
    sys.stdout.write(
        json.dumps(load_templated_fixtures(), ensure_ascii=False, sort_keys=True) + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
