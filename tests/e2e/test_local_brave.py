import os

import pytest

from brave_cli.browser import BraveSession
from brave_cli.config import Settings

pytestmark = pytest.mark.e2e


@pytest.mark.skipif(not os.getenv("BRAVE_CLI_RUN_E2E"), reason="requires explicit disposable Brave")
def test_local_brave_example_navigation() -> None:
    session = BraveSession(Settings(allowed_domains=["example.com"]))
    try:
        session.connect()
        session.navigate("https://example.com")
        assert session.page().title() == "Example Domain"
    finally:
        session.close()
