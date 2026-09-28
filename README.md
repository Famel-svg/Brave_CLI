# brave-cli-control

Rust CLI for safe local Brave automation over Chrome DevTools Protocol (CDP). Version 0.2 adds page inspection in terminal or JSON; no screenshot required.

## Inspect without screenshots

```powershell
cargo install --path .
brave-cli inspect
brave-cli inspect --format json --max-nodes 800
brave-cli inspect --format dom
```

`inspect` reports title, URL, viewport, scroll position/document size, focused element, visible page text, visible interactive/media elements with viewport rectangles, and Chrome accessibility tree (role/name/description). Output is bounded and redacts common credential fields. `--format dom` returns readable page text. Browser chrome, other desktop windows, canvas pixels, video frames, and offscreen page content are not represented; this tool inspects browser page state, not whole-desktop pixels.

## Connect and control

Start Brave with CDP enabled, using a dedicated profile:

```powershell
brave.exe --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\brave-cli-control\profile" about:blank
brave-cli doctor
brave-cli tabs
brave-cli --allow-domain example.com navigate https://example.com
brave-cli click 'button#submit' --confirm
brave-cli fill '#name' 'Rafael' --confirm
```

Config file (`--config config.toml`), environment (`BRAVE_CLI_CDP_URL`, `BRAVE_CLI_ALLOWED_DOMAINS`), then CLI allowlist apply. Navigation requires an exact or subdomain allowlist match. Click/fill require `--confirm`; `--dry-run` never connects or changes browser state. Never put secrets in shell history.

Config example:

```toml
[brave_cli]
cdp_url = "http://127.0.0.1:9222"
allowed_domains = ["example.com"]
```

## Why CDP snapshots

Chrome DevTools Protocol `DOMSnapshot.captureSnapshot` exposes flattened DOM (including iframes and shadow DOM), layout, and selected computed styles; `Accessibility.getFullAXTree` exposes semantic roles and names. This implementation uses CDP accessibility data plus visible DOM metrics/text, avoiding image capture and OCR. DOM visibility can differ from what pixels communicate; canvas/video/native browser UI remain outside scope.

## Build and test

```powershell
cargo fmt --check
cargo test
cargo build --release
```

Live CDP smoke test needs a disposable Brave profile started with remote debugging. Never target a personal browser profile in automation tests.

## Migration

Rust CLI lives in `Cargo.toml` and `src-rust/`. Python implementation remains in `src/brave_cli/` for comparison during transition; Rust is documented as the primary CLI.
