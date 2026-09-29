# brave-cli-control

Rust CLI for safe local Brave automation over Chrome DevTools Protocol (CDP). Version 0.2 adds page inspection in terminal or JSON; no screenshot required.

## Project objective

Give an AI agent a way to browse **with you in your existing Brave session**: inspect the page already open, follow links or navigate when asked, and help research topics such as current news. The project is not meant to create a new user or silently copy a browser profile. The extension route can share a tab from your signed-in profile after you explicitly attach it. The direct-CDP route can use only a Brave process that already exposes a local debugging endpoint.

Page understanding uses visible DOM text, controls, geometry, and the accessibility tree, so ordinary page inspection does not need screenshots. It is not a pixel-perfect view: browser chrome, canvas pixels, video frames, hidden/offscreen content, and other desktop windows are outside scope. News discovery, source verification, and citations are agent workflows; the bridge itself exposes browser status, inspection, navigation, and opening tabs.

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

### Direct CDP MCP (no extension)

If Brave was already started with remote debugging enabled on loopback, connect MCP directly without the extension, Native Messaging, or bridge token:

```powershell
brave-cli mcp --cdp-url http://127.0.0.1:9222
```

The direct MCP tools list page targets; select one explicitly with `browser_select_tab` before inspection or navigation. It exposes semantic DOM/accessibility inspection, navigation to public HTTP(S) URLs, and opening a new tab. It does not expose arbitrary JavaScript, cookies, browser storage, credential values, clicks, form submission, or downloads. CDP itself grants broad control to any local process able to reach its endpoint, so the client accepts loopback endpoints only and does not start or restart Brave.

Direct CDP cannot attach after the fact to a browser process that did not start with remote debugging. Enabling it may require restarting Brave. Chromium-based browser behavior around remote debugging and the default profile varies by version; Chrome 136+ requires a non-standard user-data directory for these flags, which creates a separate browser data directory and does not reuse the signed-in profile. This project never copies or changes your profile to enable CDP. If no CDP endpoint is already active, use the extension mode above to control a selected tab in the current session.

## Problems encountered and current status

During setup on Windows, the extension repeatedly reported `ERR_CONNECTION_REFUSED` when nothing was listening on its WebSocket port (`127.0.0.1:9229`). After the Rust bridge started, connections reached it but authentication failed with `token mismatch`: diagnostics showed the extension's saved token did not match the token expected by the bridge. The recovery path then reported `Specified native messaging host not found.`

The native-host executable and protocol worked in a direct local test, and the manifest/registry entries were present and pointed to that manifest. Those checks did not prove Brave itself could resolve and launch the host; the extension-context end-to-end recovery remained unsuccessful. Never put token values in logs, README, commits, or support messages.

Direct CDP was added as another transport. It avoids extension token and Native Messaging setup, but does **not** fix access to a Brave process without CDP enabled. On this machine, the running Brave did not expose a CDP endpoint; port `9229` belonged to the old extension relay, not CDP. Therefore direct mode built and passed local tests, but connection to the personal Brave session remains unverified until that session exposes a loopback CDP endpoint. Enabling CDP may require restarting Brave and may require a separate user-data directory on Chromium versions with the default-profile restriction; a separate directory will not inherit the signed-in session. The project does not restart Brave or copy/modify your profile automatically.

Configure direct MCP in Codex with:

```json
{
  "mcpServers": {
    "brave-browser": {
      "command": "C:\\Users\\<user>\\.cargo\\bin\\brave-cli.exe",
      "args": ["mcp", "--cdp-url", "http://127.0.0.1:9222"]
    }
  }
}
```

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
