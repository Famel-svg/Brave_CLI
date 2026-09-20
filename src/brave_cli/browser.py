import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

from .config import Settings
from .errors import ConnectionError
from .security import require_allowed, require_confirmation, require_safe_javascript


def detect_brave() -> Path | None:
    candidates = [
        os.environ.get("PROGRAMFILES", "") + r"\BraveSoftware\Brave-Browser\Application\brave.exe",
        os.environ.get("LOCALAPPDATA", "") + r"\BraveSoftware\Brave-Browser\Application\brave.exe",
    ]
    for candidate in candidates:
        path = Path(candidate)
        if path.is_file():
            return path
    found = shutil.which("brave") or shutil.which("brave-browser")
    return Path(found) if found else None


class BraveSession:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._playwright: Any = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None

    def start(self) -> None:
        executable = Path(self.settings.brave_path) if self.settings.brave_path else detect_brave()
        if not executable or not executable.is_file():
            raise ConnectionError("Brave executable not found")
        self.settings.user_data_dir.mkdir(parents=True, exist_ok=True)
        command = [
            str(executable),
            f"--remote-debugging-port={self.settings.cdp_port}",
            f"--user-data-dir={self.settings.user_data_dir}",
            "about:blank",
        ]
        subprocess.Popen(command, close_fds=True)  # noqa: S603
        self.connect()

    def connect(self) -> None:
        self._playwright = sync_playwright().start()
        try:
            browser = self._playwright.chromium.connect_over_cdp(self.settings.cdp_url)
            self.browser = browser
            self.context = browser.contexts[0] if browser.contexts else browser.new_context()
        except Exception as exc:
            self.close()
            raise ConnectionError(f"cannot connect CDP endpoint: {self.settings.cdp_url}") from exc

    def close(self) -> None:
        if self._playwright:
            self._playwright.stop()
        self._playwright = None
        self.browser = None
        self.context = None

    def page(self) -> Page:
        if not self.context:
            raise ConnectionError("not connected; run connect or start")
        return self.context.pages[0] if self.context.pages else self.context.new_page()

    def tabs(self) -> list[dict[str, str]]:
        if not self.context:
            raise ConnectionError("not connected")
        return [{"title": page.title(), "url": page.url} for page in self.context.pages]

    def open_tab(self, url: str, dry_run: bool = False) -> None:
        require_allowed(url, self.settings.allowed_domains, dry_run)
        page = self.context.new_page() if self.context else self.page()
        page.goto(url)

    def navigate(self, url: str, dry_run: bool = False) -> None:
        require_allowed(url, self.settings.allowed_domains, dry_run)
        self.page().goto(url)

    def click(self, selector: str, confirmed: bool = False, dry_run: bool = False) -> None:
        require_confirmation("click " + selector + " submit", confirmed, dry_run)
        if not dry_run:
            self.page().locator(selector).click()

    def fill(
        self, selector: str, value: str, confirmed: bool = False, dry_run: bool = False
    ) -> None:
        require_confirmation("fill " + selector + " account", confirmed, dry_run)
        if not dry_run:
            self.page().locator(selector).fill(value)

    def screenshot(self, filename: Path, dry_run: bool = False) -> None:
        if not dry_run:
            self.page().screenshot(path=str(filename), full_page=True)

    def evaluate(self, script: str, confirmed: bool = False, dry_run: bool = False) -> object:
        require_safe_javascript(script, confirmed, dry_run)
        return None if dry_run else self.page().evaluate(script)
