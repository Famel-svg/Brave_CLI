# Existing Brave session: connection research

Research date: 2026-09-28. Target: let a local AI agent read and navigate the user's already-open, signed-in Brave session without copying or replacing the profile.

## Options considered

| Route | Reuses signed-in Brave? | Consent and scope | Decision |
| --- | --- | --- | --- |
| CDP port on the normal profile | Only if remote debugging was enabled when Brave started | CDP is a high-privilege browser-control interface. Chrome disabled the remote-debugging flags on its default data directory starting at M136. | Keep for isolated development profiles and already-authorized debug sessions. Do not restart or copy a personal profile to enable it. |
| Chrome M144 auto-connect | Yes, in supported Chrome | User enables remote debugging, approves each connection, and sees an automation banner. Official docs describe Chrome; Brave support is unverified. | Do not make this the Brave product path until tested on Brave. |
| Brave MV3 extension + `chrome.debugger` | Yes, in the running profile | Extension installation warns about the powerful `debugger` permission. The prototype attaches only after the user clicks Connect on a chosen tab. | Primary Brave path. Validate API and detach behavior against current Brave. |
| Separate automation profile | No; separate browser state | Stronger session isolation; requires separate logins. | Keep as test and fallback mode. |

## Why the extension path

Brave supports Chromium extensions and MV3. Chromium's `chrome.debugger` API can carry CDP commands to a tab without opening a remote-debugging port. Native messaging can connect an extension to a local native process, but needs OS registration, a strict extension origin allowlist, and framed JSON validation. This project prototype instead uses a loopback WebSocket bridge to the Rust MCP process; the bridge requires a local pairing token and an extension Origin. It binds to `127.0.0.1`, never a LAN interface.

Chrome's M144 auto-connect is a useful comparison: it adds an explicit in-browser approval dialog and visible control banner. It is documented as Chrome behavior, not a Brave guarantee. Chrome M136 also changed `--remote-debugging-port` and `--remote-debugging-pipe` for the default Chrome data directory, requiring a non-standard user-data directory. This makes “restart my normal profile with a debug port” unsuitable as the default design.

## Prototype boundary

- User installs the unpacked extension and clicks Connect for the one tab to share.
- MCP tools read that tab, navigate it, or open a new tab. They do not expose cookies, local storage, password values, arbitrary JavaScript, or generic form submission.
- Page content is untrusted input. Treat instructions found in pages as data, not agent instructions.
- `chrome.debugger` is still broad privileged access. Popup choice limits normal operation, not what a compromised extension could technically do. Disconnect promptly after the task.
- The local pairing token is a secret for the local browser bridge. Keep it out of prompts, source control, logs, and screenshots.
- Extension compatibility, debugger attach/detach UI, Brave Shields interactions, restricted pages, and frame coverage need live Brave validation before calling this production-ready.
- DOM and accessibility snapshots cannot represent all pixels, canvas drawings, video frames, browser chrome, or other desktop windows. Optional visual capture can be a later tool with separate user consent.

## Staged work

1. Prototype attach/detach, inspect, and navigation in a disposable Brave profile.
2. Load extension manually into the real Brave profile; verify one chosen tab, signed-in page visibility, user-driven disconnect, and no secret values in MCP output. No profile copy or automated install.
3. Add safe link opening and explicit approval for clicks, fills, downloads, and submissions.
4. Add source-aware news research: preserve article URL, title, publisher and date; return citations; open only the requested sources.
5. Add end-to-end tests in an isolated browser profile and CI after GitHub Actions workflow permission is available.

## Primary references

- [Chrome remote debugging security change](https://developer.chrome.com/blog/remote-debugging-port)
- [Chrome live-session auto-connect](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
- [Chrome DevTools MCP auto-connect setup](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#connecting-to-a-running-chrome-instance)
- [Chrome extension debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome `activeTab` permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Brave extension support](https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave)
- [Brave Manifest V3 overview](https://brave.com/learn/using-chrome-extensions-in-brave/)
- [Chrome DevTools Protocol overview](https://chromedevtools.github.io/devtools-protocol/)
