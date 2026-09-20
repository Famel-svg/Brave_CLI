from pathlib import Path
from unittest.mock import Mock

from brave_cli.config import Settings
from brave_cli.workflow import run_workflow


def test_workflow_dispatches_safe_steps(tmp_path: Path) -> None:
    workflow = tmp_path / "workflow.yaml"
    workflow.write_text(
        "steps:\n"
        "  - navigate:\n"
        "      url: https://example.com\n"
        "  - screenshot:\n"
        "      file: shot.png\n",
        encoding="utf-8",
    )
    session = Mock()
    session.settings = Settings(allowed_domains=["example.com"])
    run_workflow(workflow, session)
    session.navigate.assert_called_once_with("https://example.com", False)
    session.screenshot.assert_called_once()
