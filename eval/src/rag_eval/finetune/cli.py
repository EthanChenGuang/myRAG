"""python -m rag_eval.finetune <command>: one dispatch table for every D-03 Python command.

Each command maps to 'module:function'; the function takes the remaining arguments and returns an exit code. A command whose
module is not in this build exits 2, so later plans add modules without editing this file.
"""
import importlib
import sys

COMMANDS: dict[str, str] = {
    "export": "rag_eval.finetune.export:main",
    "generate": "rag_eval.finetune.generate:main",
    "filter": "rag_eval.finetune.filters:main",
    "import-mined": "rag_eval.finetune.mined:main",
    "mine": "rag_eval.finetune.miner:main",
    "kit": "rag_eval.finetune.kit:main",
    "train": "rag_eval.finetune.train:main",
    "evaluate": "rag_eval.finetune.evaluate:main",
    "card": "rag_eval.finetune.card:main",
    "prune": "rag_eval.finetune.prune:main",
    "run": "rag_eval.finetune.pipeline:main",
}


def _usage() -> str:
    return "usage: python -m rag_eval.finetune <command> [options]\ncommands: " + ", ".join(COMMANDS)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] not in COMMANDS:
        print(_usage(), file=sys.stderr)
        return 2
    command, rest = args[0], args[1:]
    module_name, _, function_name = COMMANDS[command].partition(":")
    try:
        module = importlib.import_module(module_name)
    except ModuleNotFoundError as exc:
        if exc.name != module_name:
            raise
        print(f"[Finetune] {command}: not available in this build", file=sys.stderr)
        return 2
    function = getattr(module, function_name, None)
    if not callable(function):
        print(f"[Finetune] {command}: not available in this build", file=sys.stderr)
        return 2
    return int(function(rest) or 0)
