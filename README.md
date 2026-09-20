# brave-cli-control

Python 3.12 CLI for controlling a local Brave instance through Playwright and Chrome DevTools Protocol.

## Safety

Domain allowlist is mandatory for navigation. Risky browser actions require `--confirm`; unsafe JavaScript requires the same explicit flag. `--dry-run` evaluates policy without changing browser state. Logs and command output mask password, cookie, token, authorization, secret, and API-key values. The tool never reads or prints cookies, storage, passwords, or tokens.

Persistent sessions use a dedicated profile at `%LOCALAPPDATA%\brave-cli-control\profile` by default. Existing Brave profiles are never selected automatically.

## Install

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
playwright install chromium
```

Use `config.example.toml` as a starting point. Configuration precedence: CLI options, TOML file, `BRAVE_CLI_*` environment variables, defaults.

## Commands

```powershell
brave-cli doctor
brave-cli start --allow-domain example.com
brave-cli connect
brave-cli tabs
brave-cli tab open https://example.com --allow-domain example.com
brave-cli navigate https://example.com --allow-domain example.com
brave-cli click 'button#submit' --confirm
brave-cli fill '#name' 'Rafael' --confirm
brave-cli page screenshot page.png
brave-cli evaluate 'document.title'
brave-cli run workflows/example.yaml --allow-domain example.com
```

`click` and `fill` are confirmation-gated because selectors can trigger submission, account changes, purchases, deletion, uploads, or publication. Never place secrets in shell history or workflow files.

## Development

```powershell
pytest -q
ruff check .
mypy src
pyright
python -m build
```

Integration/E2E tests require a disposable local Brave process with CDP enabled. Do not point tests at a personal profile.
