from pathlib import Path
from typing import Any, cast

import yaml  # type: ignore[import-untyped]

from .browser import BraveSession
from .errors import BraveCliError


def run_workflow(path: Path, session: BraveSession, confirmed: bool = False) -> list[object]:
    data = cast(dict[str, Any], yaml.safe_load(path.read_text(encoding="utf-8")))
    if not isinstance(data.get("steps"), list):
        raise BraveCliError("workflow must contain a steps list")
    results: list[object] = []
    steps = cast(list[Any], data["steps"])
    for raw_step in steps:
        step = cast(dict[str, Any], raw_step)
        if not isinstance(step, dict) or len(step) != 1:
            raise BraveCliError("each workflow step must contain exactly one action")
        action, raw_args = next(iter(step.items()))
        args = cast(dict[str, Any], raw_args or {})
        if not isinstance(args, dict):
            raise BraveCliError(f"arguments for {action} must be a mapping")
        dry_run = session.settings.dry_run or bool(args.get("dry_run", False))
        if action == "navigate":
            session.navigate(str(args["url"]), dry_run)
            results.append(None)
        elif action == "open":
            session.open_tab(str(args["url"]), dry_run)
            results.append(None)
        elif action == "click":
            session.click(str(args["selector"]), confirmed, dry_run)
            results.append(None)
        elif action == "fill":
            session.fill(str(args["selector"]), str(args["value"]), confirmed, dry_run)
            results.append(None)
        elif action == "screenshot":
            session.screenshot(Path(str(args["file"])), dry_run)
            results.append(None)
        elif action == "evaluate":
            results.append(session.evaluate(str(args["javascript"]), confirmed, dry_run))
        else:
            raise BraveCliError(f"unsupported workflow action: {action}")
    return results
