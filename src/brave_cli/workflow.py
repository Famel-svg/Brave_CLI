from pathlib import Path
from typing import Any

import yaml

from .browser import BraveSession
from .errors import BraveCliError


def run_workflow(path: Path, session: BraveSession, confirmed: bool = False) -> list[object]:
    data: Any = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("steps"), list):
        raise BraveCliError("workflow must contain a steps list")
    results: list[object] = []
    for step in data["steps"]:
        if not isinstance(step, dict) or len(step) != 1:
            raise BraveCliError("each workflow step must contain exactly one action")
        action, args = next(iter(step.items()))
        args = args or {}
        if not isinstance(args, dict):
            raise BraveCliError(f"arguments for {action} must be a mapping")
        dry_run = session.settings.dry_run or bool(args.get("dry_run", False))
        if action == "navigate":
            results.append(session.navigate(str(args["url"]), dry_run))
        elif action == "open":
            results.append(session.open_tab(str(args["url"]), dry_run))
        elif action == "click":
            results.append(session.click(str(args["selector"]), confirmed, dry_run))
        elif action == "fill":
            results.append(session.fill(str(args["selector"]), str(args["value"]), confirmed, dry_run))
        elif action == "screenshot":
            results.append(session.screenshot(Path(str(args["file"])), dry_run))
        elif action == "evaluate":
            results.append(session.evaluate(str(args["javascript"]), confirmed, dry_run))
        else:
            raise BraveCliError(f"unsupported workflow action: {action}")
    return results
