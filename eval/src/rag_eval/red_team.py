"""Red-team attack corpus tools (Phase 7 SEC-11): add, check and report.

The committed corpus (eval/fixtures/red-team/attack-corpus.jsonl) holds synthetic items only; production-derived items (a case
promoted from a review item, paraphrased by the operator, with its review_item_id) go to the gitignored private corpus under
eval/golden/private/red-team/. Reports carry ids, counts and trace ids only, never question, document or answer text.
"""

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError
from rag_sidecar.contracts.red_team import RedTeamCorpusItem, RedTeamReport

from rag_eval.corpus import CORPUS_LANGUAGES
from rag_eval.draft.writer import PRIVATE_DIR, PrivatePathError, assert_private_path
from rag_eval.paths import REPO_ROOT, repo_relative, resolve_cli_path

PREFIX = "[Red Team]"
TECHNIQUES_PATH = REPO_ROOT / "config" / "rag" / "red-team-techniques.json"
COMMITTED_CORPUS = REPO_ROOT / "eval" / "fixtures" / "red-team" / "attack-corpus.jsonl"
PRIVATE_RED_TEAM_DIR = PRIVATE_DIR / "red-team"
PRIVATE_CORPUS = PRIVATE_RED_TEAM_DIR / "attack-corpus.jsonl"
TAG_MAX = 32
TAG_PREFIX = "rt_"


class CorpusError(ValueError):
    pass


@dataclass(frozen=True)
class Technique:
    id: str
    carrier: str
    source: str


def load_techniques(path: Path = TECHNIQUES_PATH) -> dict[str, Technique]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    out: dict[str, Technique] = {}
    for entry in data["techniques"]:
        technique_id = entry["id"]
        if technique_id in out:
            raise CorpusError(f"technique {technique_id} is listed twice")
        if len(TAG_PREFIX + technique_id) > TAG_MAX:
            raise CorpusError(
                f"technique {technique_id} does not fit the review tag limit"
            )
        out[technique_id] = Technique(
            id=technique_id, carrier=entry["carrier"], source=entry["source"]
        )
    return out


def read_corpus(path: Path) -> list[RedTeamCorpusItem]:
    """Every non-empty line validated as RedTeamCorpusItem; an invalid line raises CorpusError naming its line and id."""
    items: list[RedTeamCorpusItem] = []
    for number, line in enumerate(
        Path(path).read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not line.strip():
            continue
        try:
            items.append(RedTeamCorpusItem.model_validate_json(line))
        except ValidationError as error:
            item_id = _line_id(line)
            raise CorpusError(
                f"line {number} ({item_id}): {error.errors()[0]['msg']}"
            ) from None
    return items


def _line_id(line: str) -> str:
    try:
        value = json.loads(line).get("id")
    except (json.JSONDecodeError, AttributeError):
        return "unparsed"
    return value if isinstance(value, str) else "no id"


def check_items(
    items: list[RedTeamCorpusItem],
    techniques: dict[str, Technique],
    *,
    committed: bool,
    other_ids: frozenset[str] = frozenset(),
) -> list[str]:
    """Problems with a corpus, each naming the item id. The committed corpus must be synthetic and cover every technique in every
    fixture language."""
    problems: list[str] = []
    seen: set[str] = set()
    for item in items:
        if item.id in seen or item.id in other_ids:
            problems.append(f"{item.id}: duplicate id")
        seen.add(item.id)
        technique = techniques.get(item.technique)
        if technique is None:
            problems.append(f"{item.id}: unknown technique {item.technique}")
        elif technique.carrier != item.carrier:
            problems.append(
                f"{item.id}: carrier {item.carrier} does not match technique {item.technique} ({technique.carrier})"
            )
        if committed and item.provenance != "synthetic":
            problems.append(
                f"{item.id}: provenance {item.provenance} is not allowed in the committed corpus"
            )
    if committed:
        covered = {(item.technique, item.language) for item in items}
        for technique_id in techniques:
            for language in CORPUS_LANGUAGES:
                if (technique_id, language) not in covered:
                    problems.append(
                        f"{technique_id}/{language}: no item for this technique and language"
                    )
    return problems


def _private_target(path: Path) -> Path:
    resolved = assert_private_path(path)
    red_team = PRIVATE_RED_TEAM_DIR.resolve()
    if red_team not in resolved.parents:
        raise PrivatePathError(
            f"production items must be written under {repo_relative(PRIVATE_RED_TEAM_DIR)}/"
        )
    return resolved


def add_item(
    raw: str,
    *,
    out: Path | None = None,
    committed_path: Path = COMMITTED_CORPUS,
    private_path: Path = PRIVATE_CORPUS,
    techniques_path: Path = TECHNIQUES_PATH,
) -> Path:
    """Validate one item and append it: synthetic to the committed corpus, production only under the private red-team directory."""
    try:
        item = RedTeamCorpusItem.model_validate_json(raw)
    except ValidationError as error:
        raise CorpusError(f"{_line_id(raw)}: {error.errors()[0]['msg']}") from None
    techniques = load_techniques(techniques_path)
    if item.provenance == "production":
        target = _private_target(out if out is not None else private_path)
    else:
        target = Path(out if out is not None else committed_path).resolve()
        if target != Path(committed_path).resolve():
            raise CorpusError(
                f"{item.id}: synthetic items go to {repo_relative(committed_path)} only"
            )
    existing: set[str] = set()
    for source in {
        Path(committed_path).resolve(),
        Path(private_path).resolve(),
        target,
    }:
        if source.exists():
            existing.update(entry.id for entry in read_corpus(source))
    problems = check_items(
        [item], techniques, committed=False, other_ids=frozenset(existing)
    )
    if problems:
        raise CorpusError("; ".join(problems))
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as handle:
        handle.write(item.model_dump_json(exclude_none=True) + "\n")
    return target


def render_report(report: RedTeamReport) -> str:
    lines = [
        f"# Red-team run {report.run_id}",
        "",
        f"- started: {report.started_at}",
        f"- finished: {report.finished_at or 'not finished'}",
        f"- corpus sha256: `{report.corpus_sha256}`",
        f"- config hash: `{report.config_hash}`",
        f"- review items opened: {report.review_items_opened}",
    ]
    if report.skipped_reason:
        lines.append(f"- review cases skipped: {report.skipped_reason}")
    total = sum(cell.n for cell in report.cells)
    lines += [
        f"- attack successes: {len(report.successes)} of {total}",
        "",
        "## Attack success by technique and language",
        "",
    ]
    lines += [
        "| Technique | Language | n | Successes | Rate |",
        "| --- | --- | ---: | ---: | ---: |",
    ]
    for cell in sorted(report.cells, key=lambda c: (c.technique, c.language)):
        lines.append(
            f"| {cell.technique} | {cell.language} | {cell.n} | {cell.successes} | {cell.successes / cell.n:.3f} |"
        )
    lines += ["", "## Successes", ""]
    if not report.successes:
        lines.append("None.")
    else:
        lines += [
            "| Item | Technique | Language | Trace | Signals |",
            "| --- | --- | --- | --- | --- |",
        ]
        for success in sorted(report.successes, key=lambda s: s.item_id):
            signals = ", ".join(success.signals)
            lines.append(
                f"| {success.item_id} | {success.technique} | {success.language} | {success.trace_id} | {signals} |"
            )
    return "\n".join(lines) + "\n"


def _cmd_check(args: argparse.Namespace) -> int:
    techniques = load_techniques(resolve_cli_path(args.techniques))
    committed_path = resolve_cli_path(args.corpus)
    try:
        committed = read_corpus(committed_path)
    except CorpusError as error:
        print(f"{PREFIX} {repo_relative(committed_path)}: {error}", file=sys.stderr)
        return 1
    problems = check_items(committed, techniques, committed=True)
    private_count = 0
    private_path = resolve_cli_path(args.private) if args.private else PRIVATE_CORPUS
    if private_path.exists():
        try:
            private = read_corpus(private_path)
        except CorpusError as error:
            print(f"{PREFIX} private corpus: {error}", file=sys.stderr)
            return 1
        private_count = len(private)
        problems += check_items(
            private,
            techniques,
            committed=False,
            other_ids=frozenset(item.id for item in committed),
        )
    for problem in problems:
        print(f"{PREFIX} {problem}", file=sys.stderr)
    if problems:
        return 1
    print(
        f"{PREFIX} corpus ok: {len(committed)} committed item(s), {private_count} private item(s), {len(techniques)} technique(s)"
    )
    return 0


def _cmd_add(args: argparse.Namespace) -> int:
    raw = (
        sys.stdin.read()
        if args.item == "-"
        else resolve_cli_path(args.item).read_text(encoding="utf-8")
    )
    try:
        target = add_item(
            raw.strip(), out=resolve_cli_path(args.out) if args.out else None
        )
    except (CorpusError, PrivatePathError) as error:
        print(f"{PREFIX} not added: {error}", file=sys.stderr)
        return 1
    print(f"{PREFIX} added to {repo_relative(target)}")
    return 0


def _cmd_report(args: argparse.Namespace) -> int:
    report = RedTeamReport.model_validate_json(
        resolve_cli_path(args.report).read_text(encoding="utf-8")
    )
    markdown = render_report(report)
    if args.out:
        out = resolve_cli_path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(markdown, encoding="utf-8")
    else:
        sys.stdout.write(markdown)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="rag_eval.red_team",
        description="Red-team attack corpus: add, check, report",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser(
        "check", help="validate the committed corpus (and the private one when present)"
    )
    check.add_argument("--corpus", default=str(COMMITTED_CORPUS))
    check.add_argument("--private")
    check.add_argument("--techniques", default=str(TECHNIQUES_PATH))
    add = sub.add_parser(
        "add", help="validate and append one corpus item (JSON file or - for stdin)"
    )
    add.add_argument("--item", required=True)
    add.add_argument("--out")
    report = sub.add_parser("report", help="render a RedTeamReport as Markdown")
    report.add_argument("--report", required=True)
    report.add_argument("--out")
    args = parser.parse_args(argv)
    if args.command == "check":
        return _cmd_check(args)
    if args.command == "add":
        return _cmd_add(args)
    return _cmd_report(args)


if __name__ == "__main__":
    sys.exit(main())
