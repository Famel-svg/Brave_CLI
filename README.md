# brave-cli-control

Rust CLI for safe local Brave automation over Chrome DevTools Protocol (CDP). Version 0.2 adds page inspection in terminal or JSON; no screenshot required.

## Use the Brave session you already have open

The recommended AI connection is the Manifest V3 extension in `extension/`. It reuses your existing Brave profile and login state; it does not copy the profile, restart Brave, or open a second browser. The extension attaches only after you click **Attach to current tab**. MCP tools then expose that tab's semantic inspection, navigation, and open-in-new-tab actions.

```powershell
cargo install --path .
```

Load `extension/` unpacked from `brave://extensions`, copy its displayed ID, install the host with `brave-cli native-host-install --extension-id <id>`, then add this MCP server to Codex configuration and restart Codex:

```json
{
  "mcpServers": {
    "brave-browser": {
      "command": "C:\\Users\\<user>\\.cargo\\bin\\brave-cli.exe",
      "args": ["mcp", "--extension-id", "<extension-id>"]
    }
  }
}
```

Native Messaging supplies the bridge's current local token to the exact allowed extension ID, eliminating manual token copying and stale-token mismatches. The extension's `debugger` permission is powerful and applies to attached tabs. The WebSocket bridge binds only to loopback, pins the extension ID, requires the token, and rejects local/private IP URLs. It cannot inspect browser chrome or all rendered pixels. Remove the per-user host registration with `brave-cli native-host-uninstall`.

See [extension setup and protocol](extension/README.md) and [browser connection research](docs/browser-connection-research.md).

## Inspect without screenshots

```powershell
cargo install --path .
brave-cli inspect
brave-cli inspect --format json --max-nodes 800
brave-cli inspect --format dom
```

`inspect` reports title, URL, viewport, scroll position/document size, focused element, visible page text, visible interactive/media elements with viewport rectangles, and Chrome accessibility tree (role/name/description). Output is bounded and redacts common credential fields. `--format dom` returns readable page text. Browser chrome, other desktop windows, canvas pixels, video frames, and offscreen page content are not represented; this tool inspects browser page state, not whole-desktop pixels.

## Connect and control

Optional isolated-profile fallback for testing (does not reuse your normal Brave session):

```powershell
brave.exe --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\brave-cli-control\profile" about:blank
brave-cli doctor
brave-cli tabs
brave-cli start
brave-cli --allow-domain example.com tab open https://example.com
brave-cli --allow-domain example.com navigate https://example.com
brave-cli click 'button#submit' --confirm
brave-cli fill '#name' 'Rafael' --confirm
```

Config file (`--config config.toml`), environment (`BRAVE_CLI_CDP_URL`, `BRAVE_CLI_ALLOWED_DOMAINS`), then CLI allowlist apply. Navigation and new tabs require an exact or subdomain allowlist match. Risky click/fill require `--confirm`; all page-context JavaScript requires `--confirm` because it can act with page permissions. A basic denylist catches common direct cookie/storage/credential access patterns; it is not a JavaScript sandbox. Do not run untrusted scripts. `--dry-run` never connects or changes browser state; for YAML workflows it applies to every step. Per-step `dry_run` is rejected.

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

Live CDP tests use a disposable Brave profile. The extension is the path for the existing personal session; verify it manually on the target Brave build before relying on it.

## Existing CLI features

Rust CLI also supports `start`, `tabs`, `navigate`, `tab open`, `click`, `fill`, `evaluate`, and YAML `run` with optional screenshot steps for an explicitly debug-enabled browser. `start` is isolated-profile fallback. `inspect` supplies text/tree output without images.

```powershell
brave-cli evaluate 'document.title'
brave-cli page screenshot page.png
brave-cli --allow-domain example.com run workflows/example.yaml --dry-run
```

## Migration

Rust CLI lives in `Cargo.toml` and `src-rust/`. Python implementation remains in `src/brave_cli/` for comparison during transition; Rust is documented as the primary CLI.
