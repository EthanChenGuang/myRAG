import argparse
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from rag_eval.draft.claude_drafter import draft_with_claude
from rag_eval.draft.config import DEFAULT_CONFIG_PATH, load_draft_config
from rag_eval.draft.ragas_drafter import GenerateFn, draft_with_ragas
from rag_eval.draft.sources import DirectoryWorkspaceSource, SupabaseWorkspaceSource, WorkspaceDocument
from rag_eval.draft.verify import index_documents, verify_proposal
from rag_eval.draft.writer import (
    DEFAULT_MANIFEST,
    DraftedEntry,
    PrivatePathError,
    assert_private_path,
    write_drafted_items,
)
from rag_eval.golden_io import load_golden
from rag_eval.paths import resolve_cli_path

EXIT_OK, EXIT_INPUT, EXIT_KEYS, EXIT_PRIVATE = 0, 2, 3, 6
_QUOTED = re.compile(r"'[^']*'")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rag_eval.draft",
        description="Draft a golden set from a workspace into eval/golden/private/ for human review.",
    )
    parser.add_argument("--source", required=True, help="dir:<path> or supabase")
    scope = parser.add_argument_group("supabase scope (exactly one)")
    scope.add_argument("--org", help="organization UUID")
    scope.add_argument("--user", help="personal workspace owner UUID")
    scope.add_argument("--single-tenant", action="store_true", help="explicit single-tenant knowledge base")
    parser.add_argument("--out", required=True, help="output JSONL path inside eval/golden/private/")
    parser.add_argument("--n", type=int, default=100, help="items to draft in total (50 to 200)")
    parser.add_argument("--no-claude", action="store_true")
    parser.add_argument("--no-ragas", action="store_true")
    parser.add_argument("--split-manifest", help="split manifest path inside eval/golden/private/")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    return parser


def _load_source(args: argparse.Namespace) -> list[WorkspaceDocument] | int:
    scoped = [bool(args.org), bool(args.user), bool(args.single_tenant)]
    if args.source.startswith("dir:"):
        if any(scoped):
            print("--org, --user and --single-tenant apply only to --source supabase", file=sys.stderr)
            return EXIT_INPUT
        try:
            return DirectoryWorkspaceSource(resolve_cli_path(args.source[4:])).documents()
        except FileNotFoundError as exc:
            print(str(exc), file=sys.stderr)
            return EXIT_INPUT
    if args.source != "supabase":
        print("--source must be dir:<path> or supabase", file=sys.stderr)
        return EXIT_INPUT
    if sum(scoped) != 1:
        print("supabase source needs exactly one of --org, --user, --single-tenant", file=sys.stderr)
        return EXIT_INPUT
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for the supabase source", file=sys.stderr)
        return EXIT_KEYS
    try:
        source = SupabaseWorkspaceSource(
            url, key, organization_id=args.org, user_id=args.user, single_tenant=args.single_tenant
        )
        return source.documents()
    except (ValueError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_INPUT


def _reason_kind(reason: str) -> str:
    return _QUOTED.sub("'...'", reason)


def main(
    argv: list[str] | None = None,
    *,
    claude_client: Any = None,
    ragas_generate: GenerateFn | None = None,
) -> int:
    args = _parser().parse_args(argv)
    try:
        config = load_draft_config(Path(args.config))
    except (OSError, ValueError) as exc:
        print(f"invalid draft config: {type(exc).__name__}", file=sys.stderr)
        return EXIT_INPUT
    use_claude, use_ragas = not args.no_claude, not args.no_ragas
    if not (use_claude or use_ragas):
        print("both drafters are disabled; nothing to do", file=sys.stderr)
        return EXIT_INPUT
    if not config.min_items <= args.n <= config.max_items:
        print(f"--n must be between {config.min_items} and {config.max_items}", file=sys.stderr)
        return EXIT_INPUT

    try:
        out = assert_private_path(resolve_cli_path(args.out))
        manifest = assert_private_path(resolve_cli_path(args.split_manifest) if args.split_manifest else DEFAULT_MANIFEST)
    except PrivatePathError as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_PRIVATE

    loaded = _load_source(args)
    if isinstance(loaded, int):
        return loaded
    docs = loaded
    if not docs:
        print("no documents found in the workspace", file=sys.stderr)
        return EXIT_INPUT

    if use_claude and claude_client is None and not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set (use --no-claude to skip Claude drafting)", file=sys.stderr)
        return EXIT_KEYS
    if use_ragas and ragas_generate is None:
        missing = [name for name in ("OPENROUTER_API_KEY", "OPENAI_API_KEY") if not os.environ.get(name)]
        if missing:
            print(f"{' and '.join(missing)} not set (use --no-ragas to skip Ragas generation)", file=sys.stderr)
            return EXIT_KEYS

    n_claude = round(args.n * config.claude_share) if use_claude and use_ragas else (args.n if use_claude else 0)
    n_ragas = args.n - n_claude if use_ragas else 0

    entries: list[DraftedEntry] = []
    rejected: list[str] = []
    if use_claude:
        if claude_client is None:
            import anthropic

            claude_client = anthropic.Anthropic()
        outcome = draft_with_claude(docs, n_claude, config.languages, claude_client, config)
        entries.extend(outcome.entries)
        rejected.extend(outcome.rejected)
    if use_ragas:
        outcome = draft_with_ragas(docs, n_ragas, ragas_generate, config=config)
        entries.extend(outcome.entries)
        rejected.extend(outcome.rejected)
    drafted = len(entries)

    index = index_documents(docs)
    verified: list[DraftedEntry] = []
    for entry in entries:
        problems = verify_proposal(entry.proposal, index)
        if problems:
            rejected.extend(problems)
        else:
            verified.append(entry)

    try:
        existing = load_golden(out) if out.exists() else []
        result = write_drafted_items(verified, out, existing, manifest_path=manifest)
    except PrivatePathError as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_PRIVATE
    except ValueError as exc:
        print(f"cannot write the draft: {exc}", file=sys.stderr)
        return EXIT_INPUT
    rejected.extend(result.invalid)

    print(f"drafted {drafted} items from {len(docs)} documents")
    print(f"rejected {len(rejected)} items")
    for reason, count in sorted(Counter(_reason_kind(r) for r in rejected).items()):
        print(f"  {count} x {reason}")
    if result.duplicates:
        print(f"skipped {result.duplicates} duplicate questions")
    print(f"written {len(result.written)} new items ({len(result.written) + len(existing)} in file)")
    by_language = Counter(item.language for item in result.written)
    by_category = Counter(item.category for item in result.written)
    print("languages: " + ", ".join(f"{k}={v}" for k, v in sorted(by_language.items())))
    print("categories: " + ", ".join(f"{k}={v}" for k, v in sorted(by_category.items())))
    if len(result.written) + len(existing) < config.min_items:
        print(f"fewer than {config.min_items} items in the file; run again or raise --n", file=sys.stderr)
    return EXIT_OK
