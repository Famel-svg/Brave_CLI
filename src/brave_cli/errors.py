class BraveCliError(Exception):
    """Expected operational failure."""


class PolicyError(BraveCliError):
    """Safety policy denied operation."""


class ConnectionError(BraveCliError):
    """Browser/CDP connection failure."""
