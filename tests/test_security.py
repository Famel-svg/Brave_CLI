import pytest

from brave_cli.errors import PolicyError
from brave_cli.security import domain_allowed, mask, require_confirmation, require_safe_javascript


def test_mask_hides_sensitive_values() -> None:
    assert "hunter2" not in mask("password=hunter2 token=abc")
    assert "[REDACTED]" in mask("password=hunter2")


def test_subdomains_allowed() -> None:
    assert domain_allowed("https://sub.example.com/a", ["example.com"])
    assert not domain_allowed("https://example.net", ["example.com"])


def test_risky_action_requires_confirmation() -> None:
    with pytest.raises(PolicyError):
        require_confirmation("click submit", False)
    require_confirmation("click submit", True)


def test_unsafe_javascript_requires_confirmation() -> None:
    with pytest.raises(PolicyError):
        require_safe_javascript("document.cookie", False)
    require_safe_javascript("document.title", False)


def test_javascript_cannot_read_session_data_even_with_confirmation() -> None:
    with pytest.raises(PolicyError, match="cookies"):
        require_safe_javascript("document.cookie", True)
