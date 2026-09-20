import logging
from pathlib import Path

import typer
from rich.console import Console

from . import __version__
from .browser import BraveSession, detect_brave
from .config import Settings, load_settings
from .errors import BraveCliError
from .security import mask
from .workflow import run_workflow

app = typer.Typer(no_args_is_help=True, add_completion=False)
page_app = typer.Typer(no_args_is_help=True)
tab_app = typer.Typer(no_args_is_help=True)
app.add_typer(page_app, name="page")
app.add_typer(tab_app, name="tab")
console = Console(stderr=True)
logger = logging.getLogger("brave_cli")


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO), format="%(levelname)s %(message)s"
    )


def settings(config: Path | None, dry_run: bool, allow: list[str]) -> Settings:
    return load_settings(config, dry_run=dry_run, allowed_domains=allow or None)


def session(config: Path | None, dry_run: bool, allow: list[str]) -> BraveSession:
    current = settings(config, dry_run, allow)
    configure_logging(current.log_level)
    logger.info("browser command requested; sensitive values omitted")
    return BraveSession(current)


@app.command()
def doctor() -> None:
    """Check Python, Brave executable, and CDP endpoint configuration."""
    console.print(f"brave-cli-control {__version__}")
    console.print(f"Python OK; Brave: {detect_brave() or 'not found'}")


@app.command()
def start(
    config: Path | None = typer.Option(None),
    dry_run: bool = False,
    allow: list[str] = typer.Option([], "--allow-domain"),
) -> None:
    """Start Brave with persistent profile and connect CDP."""
    if dry_run:
        console.print("dry-run: Brave would start")
        return
    browser = session(config, dry_run, allow)
    try:
        browser.start()
        console.print("Brave CDP connected")
    finally:
        browser.close()


@app.command()
def connect(
    config: Path | None = typer.Option(None), allow: list[str] = typer.Option([], "--allow-domain")
) -> None:
    """Connect to existing CDP endpoint and verify it."""
    browser = session(config, False, allow)
    try:
        browser.connect()
        console.print(f"Connected: {len(browser.tabs())} tab(s)")
    finally:
        browser.close()


@app.command()
def tabs(
    config: Path | None = typer.Option(None), allow: list[str] = typer.Option([], "--allow-domain")
) -> None:
    browser = session(config, False, allow)
    try:
        browser.connect()
        for tab in browser.tabs():
            console.print(f"{mask(tab['title'])}\t{mask(tab['url'])}")
    finally:
        browser.close()


def command_options(config: Path | None, dry_run: bool, allow: list[str]) -> BraveSession:
    return session(config, dry_run, allow)


@tab_app.command("open")
def tab_open(
    url: str,
    config: Path | None = typer.Option(None),
    dry_run: bool = False,
    allow: list[str] = typer.Option([], "--allow-domain"),
) -> None:
    browser = command_options(config, dry_run, allow)
    try:
        browser.connect()
        browser.open_tab(url, dry_run)
    finally:
        browser.close()


@app.command()
def navigate(
    url: str,
    config: Path | None = typer.Option(None),
    dry_run: bool = False,
    allow: list[str] = typer.Option([], "--allow-domain"),
) -> None:
    browser = command_options(config, dry_run, allow)
    try:
        browser.connect()
        browser.navigate(url, dry_run)
    finally:
        browser.close()


@app.command()
def click(
    selector: str,
    confirm: bool = False,
    config: Path | None = typer.Option(None),
    dry_run: bool = False,
    allow: list[str] = typer.Option([], "--allow-domain"),
) -> None:
    browser = command_options(config, dry_run, allow)
    try:
        browser.connect()
        browser.click(selector, confirm, dry_run)
    finally:
        browser.close()


@app.command()
def fill(
    selector: str,
    value: str,
    confirm: bool = False,
    config: Path | None = typer.Option(None),
    dry_run: bool = False,
    allow: list[str] = typer.Option([], "--allow-domain"),
) -> None:
    browser = command_options(config, dry_run, allow)
    try:
        browser.connect()
        browser.fill(selector, value, confirm, dry_run)
    finally:
        browser.close()


@page_app.command("screenshot")
def screenshot(
    filename: Path,
    config: Path | None = typer.Option(None),
    dry_run: bool = False,
    allow: list[str] = typer.Option([], "--allow-domain"),
) -> None:
    browser = command_options(config, dry_run, allow)
    try:
        browser.connect()
        browser.screenshot(filename, dry_run)
    finally:
        browser.close()


@app.command()
def evaluate(
    javascript: str,
    confirm: bool = False,
    config: Path | None = typer.Option(None),
    dry_run: bool = False,
    allow: list[str] = typer.Option([], "--allow-domain"),
) -> None:
    browser = command_options(config, dry_run, allow)
    try:
        browser.connect()
        result = browser.evaluate(javascript, confirm, dry_run)
        if result is not None:
            console.print(mask(result))
    finally:
        browser.close()


@app.command()
def run(
    workflow: Path,
    confirm: bool = False,
    config: Path | None = typer.Option(None),
    dry_run: bool = False,
    allow: list[str] = typer.Option([], "--allow-domain"),
) -> None:
    browser = command_options(config, dry_run, allow)
    try:
        browser.connect()
        run_workflow(workflow, browser, confirm)
    finally:
        browser.close()


def main() -> None:
    try:
        app()
    except BraveCliError as exc:
        console.print(f"error: {mask(exc)}")
        raise typer.Exit(code=2) from exc


if __name__ == "__main__":
    main()
