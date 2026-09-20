import re
from urllib.parse import urlparse

from .errors import PolicyError

SENSITIVE = re.compile(
    r"(?i)(password|passwd|secret|token|cookie|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+"
)
UNSAFE_JS = re.compile(
    r"(?i)(document\.cookie|localStorage|sessionStorage|indexedDB|fetch\s*\(|XMLHttpRequest|navigator\.credentials)"
)
RISKY = re.compile(
    r"(?i)\b(send|publish|purchase|buy|delete|remove|upload|download|account|password|credential|submit)\b"
)


def mask(value: object) -> str:
    return SENSITIVE.sub(lambda match: f"{match.group(1)}=[REDACTED]", str(value))


def domain_allowed(url: str, allowed_domains: list[str]) -> bool:
    hostname = (urlparse(url).hostname or "").lower().rstrip(".")
    if not hostname or not allowed_domains:
        return False
    return any(
        hostname == domain or hostname.endswith(f".{domain.lstrip('.')}".lower())
        for domain in allowed_domains
    )


def require_allowed(url: str, allowed_domains: list[str], dry_run: bool = False) -> None:
    if not domain_allowed(url, allowed_domains):
        raise PolicyError("domain not in allowlist")
    if dry_run:
        raise PolicyError("dry-run: operation not executed")


def require_confirmation(description: str, confirmed: bool, dry_run: bool = False) -> None:
    if dry_run:
        return
    if RISKY.search(description) and not confirmed:
        raise PolicyError("confirmation required for risky operation")


def require_safe_javascript(script: str, confirmed: bool, dry_run: bool = False) -> None:
    if UNSAFE_JS.search(script) and not (confirmed and not dry_run):
        raise PolicyError("unsafe JavaScript requires explicit confirmation")
