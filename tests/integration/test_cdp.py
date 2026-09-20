import os

import pytest

from brave_cli.browser import BraveSession
from brave_cli.config import Settings

pytestmark = pytest.mark.integration


@pytest.mark.skipif(
    not os.getenv("BRAVE_CLI_RUN_INTEGRATION"), reason="requires explicit local CDP"
)
def test_connect_existing_cdp() -> None:
    session = BraveSession(Settings(allowed_domains=["example.com"]))
    try:
        session.connect()
        assert session.tabs()
    finally:
        session.close()
