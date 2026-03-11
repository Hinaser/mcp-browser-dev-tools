# mcp-browser-dev-tools

[![npm version](https://img.shields.io/npm/v/mcp-browser-dev-tools?label=npm)](https://www.npmjs.com/package/mcp-browser-dev-tools)
[![npm beta](https://img.shields.io/npm/v/mcp-browser-dev-tools/beta?label=beta)](https://www.npmjs.com/package/mcp-browser-dev-tools)
[![npm downloads](https://img.shields.io/npm/dm/mcp-browser-dev-tools)](https://www.npmjs.com/package/mcp-browser-dev-tools)

`mcp-browser-dev-tools` is a local MCP server that lets AI clients inspect browser state through Chromium DevTools Protocol or Firefox WebDriver BiDi.

It is designed for a local trust boundary:

`AI client -> MCP over stdio -> local broker -> browser adapter -> page target`

## What You Get

- A stdio MCP server for local desktop and terminal clients
- Browser discovery and attach/detach for Chrome, Edge, other Chromium-family browsers, and Firefox
- Tab lifecycle tools to create and close browser tabs through MCP
- Inspection tools for DOM lookup, richer element details, cookies, storage, console messages, network requests, HAR-like exports, screenshots, tab listing, and buffered events
- Page interaction tools for navigation, reload, click, hover, type, select, key presses, scroll, and viewport overrides
- Wait conditions for selector visibility, URL changes, and document ready state
- One-shot debug bundle capture for page state, storage summary, recent console, recent network, and screenshots
- Optional JavaScript evaluation behind an explicit environment flag
- Helper commands to check browser connectivity, launch a debug-enabled browser, and relay CDP traffic across a local machine boundary

## Requirements

- Node.js `24+`
- A local browser exposing either CDP or BiDi, or permission for the broker to launch one locally
- Loopback endpoints by default; remote endpoints require an explicit opt-in flag

## Quick Start

In normal use, the only thing a user should need to do is register this MCP server in their agent client. After that, let the agent drive the browser through MCP.

If you want the simplest local path, start with the default `auto` setup. The broker can auto-discover loopback CDP and BiDi ports, launch a compatible browser through MCP, and in WSL bootstrap the Windows Chrome or Edge relay when your config asks it to.

### Codex

```bash
codex mcp add browser-devtools -- npx -y mcp-browser-dev-tools serve
```

### Claude Code

```bash
claude mcp add browser-devtools --scope user -- npx -y mcp-browser-dev-tools serve
```

### Cursor

```json
{
  "mcpServers": {
    "browser-devtools": {
      "command": "npx",
      "args": ["-y", "mcp-browser-dev-tools", "serve"]
    }
  }
}
```

These commands intentionally do not include a profile flag. They only start the MCP broker. Browser launch options belong to the later `ensure_browser` or `launch_browser` call that the agent makes after the broker is running, and the broker can auto-create a temporary Chromium-family profile when that is needed.

## After Setup

Once the server is registered, the normal workflow is to ask the agent for browser work directly:

- open a browser to a URL and inspect the page
- attach to the current tab and inspect DOM, console, or network state
- take a screenshot or capture a debug report

The agent should usually start with `ensure_browser`. That tool can confirm browser availability, launch one if needed, and optionally open the requested URL in one step.

If the agent launches Chrome or Edge without `userDataDir`, the broker checks whether the same browser family is already running. If it is, the broker automatically creates a temporary profile directory before launching so the new debug flags are not swallowed by the already-running profile.

Typical temporary profile locations:

- Windows broker: `%TEMP%\\mcp-browser-dev-tools-edge` or PowerShell `$env:TEMP\\mcp-browser-dev-tools-edge`
- macOS broker: `$HOME/Library/Caches/mcp-browser-dev-tools-profile`
- Linux or WSL broker: `$HOME/.cache/mcp-browser-dev-tools-profile`

Use a path that matches the OS running the broker process. If you want a stable or reusable profile path, still pass `userDataDir` explicitly. If a browser is already open and already exposing a debug endpoint, the broker can still attach to it. If Chrome or Edge is already open without a debug endpoint, the automatic temporary profile is the default safety path for launches initiated through `ensure_browser`, `launch_browser`, or the manual `open` command.

Example `ensure_browser` payload for Chrome or Edge:

```json
{
  "browserFamily": "edge",
  "url": "https://example.com"
}
```

Add `userDataDir` only if you want to force a specific profile path.

When the broker launches a browser, the result reports the selected `userDataDir`, `profileStrategy`, and `existingBrowserProcess` state so the agent can see whether a temporary profile was chosen automatically.

## MCP Client Configuration

The same launch-profile advice applies to every MCP client config below: if you later ask the agent to launch Chrome or Edge, you can pass `userDataDir` to force a specific profile path, but if you omit it the broker can auto-create a temporary profile when an already-running Chromium-family browser would otherwise swallow the new debug flags. The config commands themselves still only launch `serve`; they do not carry browser launch arguments.

### Codex

Minimal local setup:

```bash
codex mcp add browser-devtools -- npx -y mcp-browser-dev-tools serve
```

Equivalent `~/.codex/config.toml` entry:

```toml
[mcp_servers.browser-devtools]
command = "npx"
args = ["-y", "mcp-browser-dev-tools", "serve"]
```

### Claude Code

Minimal local setup:

```bash
claude mcp add browser-devtools --scope user -- npx -y mcp-browser-dev-tools serve
```

On native Windows, wrap `npx` with `cmd /c`:

```powershell
claude mcp add browser-devtools --scope user --env MCP_BROWSER_FAMILY=auto --env CDP_BASE_URL=http://127.0.0.1:9223 --env FIREFOX_BIDI_WS_URL=ws://127.0.0.1:9222 -- cmd /c npx -y mcp-browser-dev-tools serve
```

Equivalent `.mcp.json` shape:

```json
{
  "mcpServers": {
    "browser-devtools": {
      "command": "npx",
      "args": ["-y", "mcp-browser-dev-tools", "serve"]
    }
  }
}
```

### Cursor

Minimal local setup:

```json
{
  "mcpServers": {
    "browser-devtools": {
      "command": "npx",
      "args": ["-y", "mcp-browser-dev-tools", "serve"]
    }
  }
}
```

### Common Variants

The default broker mode is `auto`. If you want to pin the broker to one browser family or one set of endpoints, change the environment in your MCP client config.

Auto mode with both browsers attached to one MCP server:

```json
{
  "MCP_BROWSER_FAMILY": "auto",
  "CDP_BASE_URL": "http://127.0.0.1:9223",
  "FIREFOX_BIDI_WS_URL": "ws://127.0.0.1:9222"
}
```

Firefox:

```json
{
  "MCP_BROWSER_FAMILY": "firefox",
  "FIREFOX_BIDI_WS_URL": "ws://127.0.0.1:9222"
}
```

Microsoft Edge:

```json
{
  "MCP_BROWSER_FAMILY": "edge",
  "CDP_BASE_URL": "http://127.0.0.1:9222"
}
```

Manual Windows browser relay into WSL:

```json
{
  "MCP_BROWSER_FAMILY": "chromium",
  "MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS": "1",
  "CDP_BASE_URL": "http://<windows-host-ip>:9223"
}
```

If you only want a single CDP browser, switch `MCP_BROWSER_FAMILY` back to `chromium` or `edge` and omit `FIREFOX_BIDI_WS_URL`.

Enable `evaluate_js`:

```json
{
  "MCP_BROWSER_ENABLE_EVAL": "1"
}
```

If you use WSL with a Windows Chrome or Edge browser, prefer `serve --bootstrap-wsl-relay` in the configured args instead of manually wiring `relay`. If you use Windows Firefox from WSL, or `auto` mode with both Windows Firefox and Windows Chrome or Edge, run the broker on Windows instead. Full examples are in [docs/setup.md](docs/setup.md).

## Advanced Environment Options

- `MCP_BROWSER_FAMILY` defaults to `auto`; set `chromium`, `edge`, or `firefox` to pin the broker to one browser family
- `CDP_BASE_URL` defaults to `http://127.0.0.1:9222`; when left at that default the broker probes loopback ports `9222` through `9226` for a reachable CDP browser endpoint
- `FIREFOX_BIDI_WS_URL` defaults to `ws://127.0.0.1:9222`; when left at that default the broker probes loopback ports `9222` through `9226`, and when pointed at the root Firefox remote debugging port it connects to the `/session` websocket and creates a BiDi session there
- in `auto` mode, assign CDP and Firefox different ports so both browsers can run at once
- `MCP_BROWSER_EVENT_BUFFER_SIZE` sets the per-session buffered event limit
- `MCP_BROWSER_LOG_LEVEL` controls diagnostic logging to `stderr`: `error`, `warn`, `info`, or `debug`
- `MCP_BROWSER_DEBUG_STDIO=1` emits raw MCP stdio transport diagnostics to `stderr`
- `MCP_BROWSER_ENABLE_EVAL=1` enables `evaluate_js`
- `MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1` allows non-loopback CDP or BiDi endpoints
- `MCP_BROWSER_ALLOW_REMOTE_CDP=1` is still accepted as a legacy alias
- `MCP_BROWSER_WINDOWS_NODE` optionally overrides the Windows `node` executable used by `serve --bootstrap-wsl-relay`
- `MCP_PROTOCOL_VERSION` overrides the advertised MCP protocol version

## Exposed Tools

- `browser_status` returns broker metadata too: `serverName` and `serverVersion`
  In `auto` mode it also includes per-browser adapter status under `browsers`
  Protocol adapters may also include `attemptedEndpoint` when discovery retries or fallback probing occur
- `ensure_browser`
  Ensures a compatible browser is reachable, launches one if needed, and can open a tab for the requested URL in a single MCP call
  In `auto` mode, pass `browserFamily`
  For Chrome or Edge launches, `userDataDir` is optional; if omitted, the broker auto-creates a temporary profile when an already-running browser process makes that necessary
- `launch_browser`
  Launches a local debug-enabled browser that matches the current broker configuration and can return an inline doctor report
  In `auto` mode, pass `browserFamily`
  For Chrome or Edge launches, `userDataDir` is optional; if omitted, the broker auto-creates a temporary profile when an already-running browser process makes that necessary
- `list_tabs`
  In `auto` mode each `targetId` is namespaced as `chromium:<id>` or `firefox:<id>`
- `new_tab`
  In `auto` mode, pass `browserFamily`
- `close_tab`
- `list_sessions`
  In `auto` mode each `sessionId` is namespaced the same way
- `attach_tab`
- `detach_tab`
- `get_page_state`
- `compare_page_state`
- `compare_selector`
- `get_cookies`
- `get_storage`
- `capture_debug_report`
- `capture_session_snapshot`
- `restore_session_snapshot`
- `get_har`
- `wait_for`
- `navigate`
- `reload`
- `click`
- `hover`
- `type`
- `select`
- `press_key`
- `scroll`
- `set_viewport`
- `get_console_messages`
- `get_network_requests`
- `get_document`
- `inspect_element`
- `take_screenshot`
- `get_events`

`evaluate_js` is intentionally disabled by default. Enable it only when you want the broker to allow page-side code execution.

For tools that take `sessionId`, call `attach_tab` first and reuse the returned session.

### Locator Syntax

Interaction and inspection tools accept these locator forms:

- CSS selectors such as `#app button.primary` or `css=.modal button`
- visible-text lookup such as `text=Open settings`
- role plus accessible name such as `role=button[name="Open settings"]`
- accessible-name lookup such as `name=Open settings`

`inspect_element` returns layout and accessibility-focused metadata including bounding box, visibility flags, interactivity flags, accessible name, inferred role, and a subset of computed styles. Invalid CSS selectors now return an explicit locator error instead of a generic DOM failure.

### Screenshot Output

`take_screenshot` returns base64 image data plus metadata such as `mimeType`, `byteLength`, and `scope`. Pass `selector` to capture a single element instead of the full page.

### Session Snapshots

- `get_cookies` returns bounded page-visible cookies from the attached page context
- `get_storage` returns bounded `localStorage` and `sessionStorage` entries and can filter to one storage area
- `capture_debug_report` bundles page state, cookie/storage summaries, recent console messages, recent network requests, and an optional screenshot
- `capture_session_snapshot` exports bounded page-visible cookies plus local and session storage for later reuse
- `restore_session_snapshot` restores a captured snapshot onto the current origin and can optionally clear storage first
- `get_har` exports buffered network activity in a bounded HAR-like JSON structure
- `compare_page_state` and `compare_selector` compare bounded state across two attached sessions, which is especially useful in `auto` mode

## Browser Notes

- Chromium uses the standard DevTools endpoints at `/json/version` and `/json/list`
- Firefox support expects a direct BiDi websocket endpoint
- In WSL, Linux browser executables are preferred before Windows fallback paths
- For Windows Chrome or Edge + WSL, prefer the broker-managed relay path over changing the browser's remote debugging bind

## Why Not Playwright?

Playwright is still the stronger choice for deterministic browser automation and end-to-end tests. It has a more mature locator model, assertions, waiting semantics, tracing, and CI story.

`mcp-browser-dev-tools` solves a different problem:

- it is MCP-native, so AI clients call a bounded tool surface instead of generating and executing Playwright scripts
- it can inspect an already-open browser tab or create a fresh one, then inspect the current session state, cookies, login state, extensions, console, and network history
- it is designed for local AI debugging workflows, including loopback-only defaults, opt-in evaluation, and the Windows-to-WSL relay path
- it presents one MCP interface across Chromium CDP and Firefox BiDi instead of requiring the AI client to know browser protocol details

Use Playwright when you want reproducible automation. Use this project when you want an AI assistant to inspect and manipulate a live browser session through MCP.

## Debugging Notes

- `attach_tab` now seeds network history from the Performance API so already-loaded pages still show useful requests
- console buffers include source URL, line and column where the browser reports them, plus stack frames when available
- `get_page_state` reports the current URL, title, viewport, and scroll position without enabling `evaluate_js`
- broker diagnostics write to `stderr` so `stdout` stays reserved for MCP protocol traffic

## Safety Defaults

- The broker only allows loopback browser endpoints unless you opt in
- The default tool surface is read-focused
- Arbitrary page evaluation is opt-in
- Clients interact with a bounded MCP tool surface instead of raw browser protocol calls

## Development

```bash
corepack enable
pnpm install
pnpm run check
pnpm run pack:check
```

The repository uses `pnpm` for local development and CI. End-user installation and publish flows still target the npm registry.

Additional docs:

- [Architecture](docs/architecture.md)
- [Manual Verification And Troubleshooting](docs/setup.md)
- [Repository Settings](docs/repository-settings.md)
- [Publishing](PUBLISHING.md)
