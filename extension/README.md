# Brave Browser Bridge (MV3)

Extension attaches only after user clicks **Attach to current tab**. It never attaches on startup. Once attached, local Rust bridge can inspect and control that tab using CDP. Click **Detach** to release it.

## Install in Brave

1. Build Rust CLI: `cargo build --release`.
2. Open `brave://extensions`, enable **Developer mode**, choose **Load unpacked**, select this `extension/` directory. Copy the extension ID shown there.
3. Install the per-user Native Messaging host: `target\release\brave-cli.exe native-host-install --extension-id <id>`. This registers `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.famel.brave_cli` and creates a manifest restricted to that exact extension ID. It needs no administrator rights. The host reads the same token source as the Rust bridge; token no longer needs manual copying.
4. Start the MCP server with `brave-cli mcp --extension-id <id>` and restart Codex. Server listens only on `127.0.0.1:9229`.
5. Reload the unpacked extension once after changing its manifest/code. Open extension **Details** and pin it if desired. Read debugger permission warning: `debugger` grants broad DevTools Protocol access to attached tabs, including page inspection and actions.
   The Bridge settings page probes the Native Messaging host and automatically restarts the worker after a successful probe. Refresh that page to recover a worker that started before host registration.
6. Select intended tab, then click **Attach to current tab**. Attach fails on browser-internal or non-HTTP(S) pages.
7. Click **Detach** when done. The bridge cannot inspect or navigate a tab unless one is attached.

Remove host registration with `target\release\brave-cli.exe native-host-uninstall`.

Example MCP configuration (replace path and extension ID):

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

## Extension ID and Origin

WebSocket handshake `Origin` is `chrome-extension://<extension-id>`. Rust requires the exact ID passed with `--extension-id`; it rejects other/missing origins. Unpacked extension IDs can depend on installation path. Stable extension ID for packaged distribution requires a fixed manifest public key and separately managed signing.

Chrome host-permission match patterns support HTTP(S), not `ws:`. Manifest therefore grants only `http://127.0.0.1:9229/*`; extension-page CSP permits WebSocket only to `ws://127.0.0.1:9229`. No remote host permission exists. Rust validates loopback peer, exact Origin, token, command schema, and URL/message size boundaries independently.

## Rust bridge JSON schema

All frames are UTF-8 JSON text. Extension caps incoming and outgoing frames at 4,000,000 characters. Reject malformed JSON and unsupported protocol values.

First frame after each WebSocket open:

```json
{"type":"hello","protocol":1,"token":"<shared-token-or-empty>"}
```

Bridge authentication reply:

```json
{"type":"hello","ok":true}
```

or rejection:

```json
{"type":"hello","ok":false,"error":"authentication failed"}
```

After authentication, bridge may send request frames:

```json
{"type":"request","id":"req-001","command":"inspect","params":{}}
```

Supported commands:

- `status`, params `{}`: attached state and attached tab metadata.
- `inspect`, params `{}`: attached page URL/title, viewport/scroll, visible page text/elements, and up to 5,000 CDP accessibility nodes. No screenshot.
- `navigate`, params `{"url":"https://example.org/"}`: navigate attached tab.
- `openTab`, params `{"url":"https://example.org/"}`: open URL in active new tab; this new tab does not become debugger-attached automatically.

Success reply:

```json
{"type":"response","id":"req-001","ok":true,"result":{}}
```

Failure reply:

```json
{"type":"response","id":"req-001","ok":false,"error":"No tab attached; attach explicitly from extension popup"}
```

Extension emits keepalive frames every 20 seconds while connected:

```json
{"type":"ping","at":1780000000000}
```

Bridge may ignore them or reply `{"type":"pong","at":1780000000000}`. Re-authenticate on every reconnect. Never log token, page content, or sensitive fields. Treat page text and AX labels as untrusted input; prompt injection can appear in browser content.

URL rules: only public `http:` and `https:`; reject username/password, `javascript:`, `data:`, `file:`, `chrome:`, `brave:`, localhost, local names and direct private IPs. Extension validates schemes; Rust repeats and strengthens URL validation. DNS rebinding is outside this URL-only check.

## Limits

## Connection diagnostics

Open **Extension settings** and use **Refresh diagnostics** or **Export sanitized log**. The extension keeps the newest 200 events in local storage: worker build, connection transitions, retry decisions, storage revision, and token metadata (present, character count, hexadecimal format). It never records token or hash. **Clear diagnostics** removes this log.

Rust bridge writes connection/auth events to `%LOCALAPPDATA%\\brave-cli-control\\bridge.log` on Windows (or beside `bridge.token` in the per-user config directory elsewhere). It rotates at 1 MB to `bridge.log.1`. Log includes loopback peer, Origin handshake outcome, hello result, failure category, and received token length/hex format on rejected auth. No token value or browser page content enters log. Check logs for private paths before sharing.

- Brave compatibility not runtime-verified here; install and test on the target Brave build.
- `chrome.debugger` protocol access is broad and may show browser-controlled debugger UI or detach when DevTools/another debugger takes over.
- Inspection is DOM/AX semantic data, not pixels. Canvas drawing, video frames, browser chrome, occlusion, and some cross-origin/out-of-process frame content may be missing.
- Password-like inputs are excluded/redacted, but page text may still contain secrets in arbitrary formats. Do not send private pages unless intended.
- WebSocket is loopback-only and uses plain `ws`; exact extension Origin and a shared token are required. A same-user local process can still read the token file, so this does not defend against malware already running as the user.
