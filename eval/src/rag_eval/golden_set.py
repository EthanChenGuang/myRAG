"""Golden-set manifests (Phase 5.3 D-46, D-48, D-49): verify, bump, retire, relabel and stale-scan a golden set.

A manifest sits next to its JSONL and holds one hash and lifecycle status per item. Items are never deleted: an item
leaves the gate only as stale or retired, with the reason recorded. Marking an item stale changes the manifest only.
"""

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any

from pydantic import ValidationError
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.golden_lifecycle import (
    CODE_PATTERN,
    GoldenSetChangelogEntry,
    GoldenSetManifest,
    GoldenSetManifestItem,
    manifest_hash,
)

from rag_eval.corpus import CorpusDocument, load_corpus
from rag_eval.draft.writer import PrivatePathError, assert_private_path
from rag_eval.golden_io import item_sha256, load_golden
from rag_eval.matching import normalize_text
from rag_eval.paths import REPO_ROOT, resolve_cli_path

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_CRASH = 70

FIXTURE_DIR = REPO_ROOT / "eval" / "fixtures"
FIXTURE_CORPUS_DIR = REPO_ROOT / "eval" / "fixtures" / "corpus"
FIXTURE_SET_ID = "fixture"
PENDING_REAL_SET = "needs plan 05.3-35"

STALE_DOCUMENT_MISSING = "document_missing"
STALE_QUOTE_NOT_FOUND = "quote_not_found"

_CODE_RE = re.compile(CODE_PATTERN)


class LifecycleError(ValueError):
    pass


def _today(today: dt.date | None) -> dt.date:
    return today if today is not None else dt.date.today()


def _seal(set_id: str, version: int, items: Iterable[GoldenSetManifestItem], changelog: list[GoldenSetChangelogEntry]) -> GoldenSetManifest:
    ordered = sorted(items, key=lambda entry: entry.id)
    payload: dict[str, Any] = {
        "schema_version": 1,
        "set_id": set_id,
        "version": version,
        "items": [entry.model_dump(mode="json") for entry in ordered],
        "changelog": [entry.model_dump(mode="json") for entry in changelog],
    }
    payload["manifest_sha256"] = manifest_hash(payload)
    return GoldenSetManifest.model_validate(payload)


def _next_version(
    manifest: GoldenSetManifest,
    items: Iterable[GoldenSetManifestItem],
    today: dt.date,
    *,
    added: Iterable[str] = (),
    changed: Iterable[str] = (),
    retired: Iterable[str] = (),
    stale: Iterable[str] = (),
) -> GoldenSetManifest:
    version = manifest.version + 1
    entry = GoldenSetChangelogEntry(
        version=version,
        date=today,
        added=sorted(added),
        changed=sorted(changed),
        retired=sorted(retired),
        stale=sorted(stale),
    )
    return _seal(manifest.set_id, version, items, [*manifest.changelog, entry])


def _by_id(items: Iterable[GoldenItem]) -> dict[str, GoldenItem]:
    result: dict[str, GoldenItem] = {}
    for item in items:
        if item.id in result:
            raise LifecycleError(f"duplicate golden item id {item.id!r} in the set")
        result[item.id] = item
    return result


def build_manifest(
    set_id: str,
    items: list[GoldenItem],
    previous: GoldenSetManifest | None = None,
    today: dt.date | None = None,
) -> GoldenSetManifest:
    """Version 1 of a new set (every item active), or the next version of `previous` (see `bump`)."""

    day = _today(today)
    if previous is not None:
        bumped = bump(items, previous, today=day)
        return bumped if bumped is not None else previous
    current = _by_id(items)
    entries = [
        GoldenSetManifestItem(id=item_id, item_sha256=item_sha256(item), status="active", last_reviewed_at=day)
        for item_id, item in current.items()
    ]
    changelog = [GoldenSetChangelogEntry(version=1, date=day, added=sorted(current))]
    return _seal(set_id, 1, entries, changelog)


def _manifest_entries(manifest: GoldenSetManifest | Mapping[str, Any]) -> tuple[list[GoldenSetManifestItem], list[str]]:
    if isinstance(manifest, GoldenSetManifest):
        return list(manifest.items), []
    problems: list[str] = []
    recorded = manifest.get("manifest_sha256")
    try:
        expected = manifest_hash(dict(manifest))
    except (ValidationError, ValueError, TypeError) as exc:
        raise LifecycleError(f"invalid manifest: {exc}") from exc
    if recorded != expected:
        problems.append(f"manifest_sha256 mismatch: recorded {recorded}, content hashes to {expected}")
    try:
        GoldenSetManifest.model_validate({**manifest, "manifest_sha256": expected})
    except ValidationError as exc:
        raise LifecycleError(f"invalid manifest: {exc}") from exc
    return [GoldenSetManifestItem.model_validate(entry) for entry in manifest.get("items", [])], problems


def verify_manifest(items: list[GoldenItem], manifest: GoldenSetManifest | Mapping[str, Any]) -> list[str]:
    """Every difference between a golden set and its manifest; an empty list means they match."""

    entries, problems = _manifest_entries(manifest)
    recorded = {entry.id: entry for entry in entries}
    current = _by_id(items)
    for item_id in sorted(set(current) - set(recorded)):
        problems.append(f"added: {item_id} is in the golden file but not in the manifest")
    for item_id in sorted(set(recorded) - set(current)):
        problems.append(f"removed: {item_id} is in the manifest but not in the golden file")
    for item_id in sorted(set(current) & set(recorded)):
        if item_sha256(current[item_id]) != recorded[item_id].item_sha256:
            problems.append(f"changed: {item_id} differs from its manifest hash")
    return problems


def bump(items: list[GoldenItem], manifest: GoldenSetManifest, today: dt.date | None = None) -> GoldenSetManifest | None:
    """Record added and changed active items under version N+1; None when nothing changed."""

    day = _today(today)
    current = _by_id(items)
    recorded = {entry.id: entry for entry in manifest.items}
    removed = sorted(set(recorded) - set(current))
    if removed:
        raise LifecycleError(
            f"items missing from the golden file: {', '.join(removed)}; nothing is deleted, retire them and keep their lines"
        )
    added = sorted(set(current) - set(recorded))
    changed = sorted(item_id for item_id in recorded if item_sha256(current[item_id]) != recorded[item_id].item_sha256)
    not_active = [item_id for item_id in changed if recorded[item_id].status != "active"]
    if not_active:
        raise LifecycleError(f"changed items that are not active: {', '.join(not_active)}; use relabel")
    if not added and not changed:
        return None
    entries = dict(recorded)
    for item_id in added:
        entries[item_id] = GoldenSetManifestItem(
            id=item_id, item_sha256=item_sha256(current[item_id]), status="active", last_reviewed_at=day
        )
    for item_id in changed:
        entries[item_id] = recorded[item_id].model_copy(
            update={"item_sha256": item_sha256(current[item_id]), "last_reviewed_at": day}
        )
    return _next_version(manifest, entries.values(), day, added=added, changed=changed)


def _require_code(reason: str | None, what: str) -> str:
    if not reason:
        raise LifecycleError(f"{what} needs a reason")
    if not _CODE_RE.match(reason):
        raise LifecycleError(f"{what} reason must be a code matching {CODE_PATTERN}, got {reason!r}")
    return reason


def _entry(manifest: GoldenSetManifest, item_id: str) -> GoldenSetManifestItem:
    for entry in manifest.items:
        if entry.id == item_id:
            return entry
    raise LifecycleError(f"unknown item id {item_id!r} in set {manifest.set_id}")


def retire(manifest: GoldenSetManifest, item_id: str, reason: str | None, today: dt.date | None = None) -> GoldenSetManifest:
    code = _require_code(reason, "retire")
    entry = _entry(manifest, item_id)
    if entry.status == "retired":
        raise LifecycleError(f"{item_id} is already retired")
    day = _today(today)
    updated = GoldenSetManifestItem(
        id=entry.id,
        item_sha256=entry.item_sha256,
        status="retired",
        retire_reason=code,
        stale_reason=entry.stale_reason,
        stale_since=entry.stale_since,
        last_reviewed_at=day,
    )
    entries = [updated if e.id == item_id else e for e in manifest.items]
    return _next_version(manifest, entries, day, retired=[item_id])


def relabel(
    items: list[GoldenItem], manifest: GoldenSetManifest, item_id: str, today: dt.date | None = None
) -> GoldenSetManifest:
    """An expert fixed or confirmed the item: store its current hash, return it to active, bump the version."""

    entry = _entry(manifest, item_id)
    current = _by_id(items)
    if item_id not in current:
        raise LifecycleError(f"{item_id} is not in the golden file")
    day = _today(today)
    updated = GoldenSetManifestItem(
        id=item_id, item_sha256=item_sha256(current[item_id]), status="active", last_reviewed_at=day
    )
    entries = [updated if e.id == entry.id else e for e in manifest.items]
    return _next_version(manifest, entries, day, changed=[item_id])


def corpus_documents(corpus: Iterable[CorpusDocument]) -> dict[str, str]:
    return {doc.filename: doc.content for doc in corpus}


def _stale_reason(item: GoldenItem, documents: Mapping[str, str]) -> str | None:
    by_name = {name.casefold(): normalize_text(text) for name, text in documents.items()}
    for span in item.gold_evidence:
        text = by_name.get(span.document.casefold())
        if text is None:
            return STALE_DOCUMENT_MISSING
        if normalize_text(span.quote) not in text:
            return STALE_QUOTE_NOT_FOUND
    return None


def stale_scan_fixture(
    items: list[GoldenItem],
    manifest: GoldenSetManifest,
    documents: Mapping[str, str],
    today: dt.date | None = None,
) -> tuple[GoldenSetManifest | None, list[dict[str, str]]]:
    """Mark active items whose gold document or quote is gone from the fixture corpus as stale.

    `documents` maps a document name to its text. Returns the next manifest version (None when no item became stale)
    and one finding per newly stale item. Stale items keep their first `stale_since`; only relabel returns them.
    """

    day = _today(today)
    current = _by_id(items)
    findings: list[dict[str, str]] = []
    entries: list[GoldenSetManifestItem] = []
    for entry in manifest.items:
        item = current.get(entry.id)
        reason = _stale_reason(item, documents) if entry.status == "active" and item is not None else None
        if reason is None:
            entries.append(entry)
            continue
        findings.append({"id": entry.id, "reason": reason})
        entries.append(entry.model_copy(update={"status": "stale", "stale_reason": reason, "stale_since": day}))
    if not findings:
        return None, []
    return _next_version(manifest, entries, day, stale=[f["id"] for f in findings]), findings


def quote_sha256(quote: str) -> str:
    return hashlib.sha256(normalize_text(quote).encode("utf-8")).hexdigest()


def registration_rows(items: list[GoldenItem], resolve: Callable[[str], str | None]) -> list[dict[str, str | None]]:
    """One row per gold span for the evidence index (plan 05.3-35): ids and hashes, never quote text."""

    rows: list[dict[str, str | None]] = []
    for item in items:
        for span in item.gold_evidence:
            rows.append({"item_id": item.id, "document_id": resolve(span.document), "quote_sha256": quote_sha256(span.quote)})
    return rows


def load_golden_set(paths: Iterable[Path]) -> list[GoldenItem]:
    items: list[GoldenItem] = []
    for path in paths:
        items.extend(load_golden(path))
    _by_id(items)
    return items


def load_manifest(path: Path) -> GoldenSetManifest:
    try:
        return GoldenSetManifest.model_validate_json(Path(path).read_text(encoding="utf-8"))
    except ValidationError as exc:
        raise LifecycleError(f"{path}: invalid manifest: {exc}") from exc


def _is_fixture_path(path: Path) -> bool:
    resolved = path.resolve()
    fixtures = Path(FIXTURE_DIR).resolve()
    return fixtures in resolved.parents


def check_manifest_path(path: Path) -> Path:
    """Fixture manifests live under eval/fixtures/; every other manifest must be a private, git-ignored file."""

    if _is_fixture_path(path):
        return path
    return assert_private_path(path)


def write_manifest(path: Path, manifest: GoldenSetManifest) -> None:
    check_manifest_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(manifest.model_dump_json(indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _summary(manifest: GoldenSetManifest) -> str:
    counts = {"active": 0, "stale": 0, "retired": 0}
    for entry in manifest.items:
        counts[entry.status] += 1
    return (
        f"set {manifest.set_id} version {manifest.version}: {len(manifest.items)} items "
        f"(active {counts['active']}, stale {counts['stale']}, retired {counts['retired']}), "
        f"manifest {manifest.manifest_sha256}"
    )


def _paths(args: argparse.Namespace) -> tuple[list[Path], Path]:
    manifest = check_manifest_path(resolve_cli_path(args.manifest))
    return [resolve_cli_path(p) for p in args.golden], manifest


def _cmd_verify(args: argparse.Namespace) -> int:
    golden, manifest_path = _paths(args)
    raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    problems = verify_manifest(load_golden_set(golden), raw)
    if problems:
        for problem in problems:
            print(f"mismatch: {problem}")
        print(f"{len(problems)} mismatch(es) between the golden file and {manifest_path}; run bump, retire or relabel")
        return EXIT_USAGE
    print(f"ok: {_summary(load_manifest(manifest_path))}")
    return EXIT_OK


def _cmd_bump(args: argparse.Namespace) -> int:
    golden, manifest_path = _paths(args)
    items = load_golden_set(golden)
    today = args.date
    if not manifest_path.exists():
        if not args.set_id:
            raise LifecycleError(f"{manifest_path} does not exist; pass --set-id to create version 1")
        manifest = build_manifest(args.set_id, items, today=today)
        write_manifest(manifest_path, manifest)
        print(f"created {manifest_path}: {_summary(manifest)}")
        return EXIT_OK
    previous = load_manifest(manifest_path)
    if args.set_id and args.set_id != previous.set_id:
        raise LifecycleError(f"--set-id {args.set_id} does not match the manifest set id {previous.set_id}")
    bumped = bump(items, previous, today=today)
    if bumped is None:
        print(f"nothing to bump: {_summary(previous)}")
        return EXIT_OK
    write_manifest(manifest_path, bumped)
    entry = bumped.changelog[-1]
    print(f"bumped to version {bumped.version}: added {len(entry.added)}, changed {len(entry.changed)}")
    return EXIT_OK


def _load_matching(args: argparse.Namespace) -> tuple[list[GoldenItem], Path, GoldenSetManifest]:
    golden, manifest_path = _paths(args)
    items = load_golden_set(golden)
    manifest = load_manifest(manifest_path)
    problems = verify_manifest(items, manifest)
    if problems:
        raise LifecycleError("golden file and manifest differ; run verify first: " + "; ".join(problems))
    return items, manifest_path, manifest


def _cmd_retire(args: argparse.Namespace) -> int:
    if not args.id:
        raise LifecycleError("retire needs --id")
    _require_code(args.reason, "retire")
    _, manifest_path, manifest = _load_matching(args)
    retired = retire(manifest, args.id, args.reason, today=args.date)
    write_manifest(manifest_path, retired)
    print(f"retired {args.id} ({args.reason}): version {retired.version}")
    return EXIT_OK


def _cmd_relabel(args: argparse.Namespace) -> int:
    if not args.id:
        raise LifecycleError("relabel needs --id")
    golden, manifest_path = _paths(args)
    items = load_golden_set(golden)
    manifest = load_manifest(manifest_path)
    others = [p for p in verify_manifest(items, manifest) if not p.split(": ", 1)[-1].startswith(f"{args.id} ")]
    if others:
        raise LifecycleError("golden file and manifest differ beyond the relabelled item: " + "; ".join(others))
    relabelled = relabel(items, manifest, args.id, today=args.date)
    write_manifest(manifest_path, relabelled)
    print(f"relabelled {args.id}: version {relabelled.version}")
    return EXIT_OK


def _cmd_stale_scan(args: argparse.Namespace) -> int:
    if args.base_url:
        print(f"error: the real-set stale scan through the evidence-check route {PENDING_REAL_SET}", file=sys.stderr)
        return EXIT_USAGE
    items, manifest_path, manifest = _load_matching(args)
    if args.corpus:
        corpus_dir = resolve_cli_path(args.corpus)
    elif manifest.set_id == FIXTURE_SET_ID:
        corpus_dir = FIXTURE_CORPUS_DIR
    else:
        raise LifecycleError(f"set {manifest.set_id} has no default corpus; pass --corpus <dir> or --base-url <url>")
    scanned, findings = stale_scan_fixture(items, manifest, corpus_documents(load_corpus(corpus_dir)), today=args.date)
    if scanned is None:
        print(f"stale-scan: 0 newly stale; {_summary(manifest)}")
        return EXIT_OK
    for finding in findings:
        print(f"stale: {finding['id']} ({finding['reason']})")
    write_manifest(manifest_path, scanned)
    print(f"stale-scan: {len(findings)} newly stale; {_summary(scanned)}")
    return EXIT_OK


def _cmd_register(_args: argparse.Namespace) -> int:
    print(f"error: registering real-set evidence {PENDING_REAL_SET}", file=sys.stderr)
    return EXIT_USAGE


def _date(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"not a YYYY-MM-DD date: {value}") from exc


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.golden_set", description=__doc__.split("\n", 1)[0])
    sub = parser.add_subparsers(dest="command", required=True)
    specs = {
        "bump": "record added or changed items under a new version (creates version 1 with --set-id)",
        "verify": "fail (exit 2) when the golden file differs from its manifest",
        "retire": "retire one item with a reason code",
        "relabel": "store an edited item's new hash and return it to active",
        "stale-scan": "mark items whose evidence is gone from the corpus as stale",
        "register": "register real-set evidence hashes in the evidence index",
    }
    for name, help_text in specs.items():
        cmd = sub.add_parser(name, help=help_text)
        cmd.add_argument("--golden", action="append", required=True, help="golden JSONL (repeat for a set of several files)")
        cmd.add_argument("--manifest", required=True, help="manifest JSON next to the golden file")
        cmd.add_argument("--date", type=_date, default=None, help=argparse.SUPPRESS)
        if name == "bump":
            cmd.add_argument("--set-id", default=None)
        if name in ("retire", "relabel"):
            cmd.add_argument("--id", default=None)
        if name == "retire":
            cmd.add_argument("--reason", default=None, help="reason code, e.g. obsolete")
        if name == "stale-scan":
            cmd.add_argument("--corpus", default=None, help="fixture corpus directory (default for set fixture)")
            cmd.add_argument("--base-url", default=None, help="real sets: the app's evidence-check route")
        if name == "register":
            cmd.add_argument("--tenant", default=None)
            cmd.add_argument("--base-url", default=None)
    return parser


COMMANDS: dict[str, Callable[[argparse.Namespace], int]] = {
    "bump": _cmd_bump,
    "verify": _cmd_verify,
    "retire": _cmd_retire,
    "relabel": _cmd_relabel,
    "stale-scan": _cmd_stale_scan,
    "register": _cmd_register,
}


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else EXIT_USAGE
    try:
        return COMMANDS[args.command](args)
    except (LifecycleError, PrivatePathError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except Exception as exc:  # noqa: BLE001
        print(f"crash: {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_CRASH


if __name__ == "__main__":
    sys.exit(main())
