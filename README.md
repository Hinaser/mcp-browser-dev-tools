# mcp-browser-dev-tools

`mcp-browser-dev-tools` is a local MCP server that lets AI clients inspect browser state through Chromium DevTools Protocol or Firefox WebDriver BiDi.

It is designed for a local trust boundary:

`AI client -> MCP over stdio -> local broker -> browser adapter -> page target`

## What You Get

- A stdio MCP server for local desktop and terminal clients
- Browser discovery and attach/detach for Chromium-family browsers and Firefox
- Inspection tools for DOM lookup, richer element details, console messages, network requests, screenshots, tab listing, and buffered events
- Page interaction tools for navigation, reload, click, hover, type, select, key presses, scroll, and viewport overrides
- Optional JavaScript evaluation behind an explicit environment flag
- Helper commands to check browser connectivity, launch a debug-enabled browser, and relay CDP traffic across a local machine boundary

## Requirements

- Node.js `24+`
- A local browser exposing either CDP or BiDi
- Loopback endpoints by default; remote endpoints require an explicit opt-in flag

## Install

If you are trying the prerelease from npm, replace `mcp-browser-dev-tools` below with `mcp-browser-dev-tools@beta`.

The published package name stays `mcp-browser-dev-tools`. The preferred installed CLI command is `mbdt`.

One-off execution with `npx`:

```bash
npx -y mcp-browser-dev-tools serve
```

Global install:

```bash
npm install -g mcp-browser-dev-tools
mbdt serve
```

Project-local install:

```bash
npm install mcp-browser-dev-tools
npx mbdt serve
```

## Try It Locally

You can smoke-test the broker before wiring it into an MCP client.

For Windows, WSL, macOS, and Linux-specific setup paths, see [docs/setup.md](docs/setup.md).

Quick Chromium flow:

```bash
# Launch a local browser with remote debugging enabled.
# open waits for the debug endpoint and prints the doctor summary automatically.
npx -y mcp-browser-dev-tools@beta open about:blank --family chromium
```

If you want to verify a specific app URL too:

```bash
npx -y mcp-browser-dev-tools@beta doctor --url http://127.0.0.1:3000
```

Then start the MCP server in a dedicated terminal:

```bash
npx -y mcp-browser-dev-tools@beta serve
```

`serve` stays attached to stdio because MCP clients talk to it over standard input and output. Run it in its own terminal or let your MCP client spawn it directly.

If you already have a browser listening on `http://127.0.0.1:9222`, `doctor` is enough to confirm that the broker can reach it:

```bash
CDP_BASE_URL=http://127.0.0.1:9222 npx -y mcp-browser-dev-tools@beta doctor
```

If you need to bridge Windows Chrome into WSL without changing WSL networking mode, run the relay on Windows and point WSL at the relay port instead. The full procedure is in [docs/setup.md](docs/setup.md).

## MCP Client Configuration

Use the same server command across MCP clients:

```bash
npx -y mcp-browser-dev-tools@beta serve
```

If you installed the package already, the shorter equivalent is:

```bash
mbdt serve
```

### Codex

Add the server with the Codex CLI:

```bash
codex mcp add browser-devtools \
  --env MCP_BROWSER_FAMILY=chromium \
  --env CDP_BASE_URL=http://127.0.0.1:9222 \
  -- npx -y mcp-browser-dev-tools@beta serve
```

Equivalent `~/.codex/config.toml` entry:

```toml
[mcp_servers.browser-devtools]
command = "npx"
args = ["-y", "mcp-browser-dev-tools@beta", "serve"]

[mcp_servers.browser-devtools.env]
MCP_BROWSER_FAMILY = "chromium"
CDP_BASE_URL = "http://127.0.0.1:9222"
```

### Claude Code

Add the server with Claude Code:

```bash
claude mcp add browser-devtools --scope user \
  --env MCP_BROWSER_FAMILY=chromium \
  --env CDP_BASE_URL=http://127.0.0.1:9222 \
  -- npx -y mcp-browser-dev-tools@beta serve
```

On native Windows, wrap `npx` with `cmd /c`:

```powershell
claude mcp add browser-devtools --scope user --env MCP_BROWSER_FAMILY=chromium --env CDP_BASE_URL=http://127.0.0.1:9222 -- cmd /c npx -y mcp-browser-dev-tools@beta serve
```

Equivalent `.mcp.json` shape:

```json
{
  "mcpServers": {
    "browser-devtools": {
      "command": "npx",
      "args": ["-y", "mcp-browser-dev-tools@beta", "serve"],
      "env": {
        "MCP_BROWSER_FAMILY": "chromium",
        "CDP_BASE_URL": "http://127.0.0.1:9222"
      }
    }
  }
}
```

### Cursor

Cursor reads MCP servers from `mcp.json`:

```json
{
  "mcpServers": {
    "browser-devtools": {
      "command": "npx",
      "args": ["-y", "mcp-browser-dev-tools", "serve"],
      "env": {
        "MCP_BROWSER_FAMILY": "chromium",
        "CDP_BASE_URL": "http://127.0.0.1:9222"
      }
    }
  }
}
```

### Common Variants

Firefox:

```json
{
  "MCP_BROWSER_FAMILY": "firefox",
  "FIREFOX_BIDI_WS_URL": "ws://127.0.0.1:9222"
}
```

Windows browser bridged into WSL through the relay:

```json
{
  "MCP_BROWSER_FAMILY": "chromium",
  "MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS": "1",
  "CDP_BASE_URL": "http://<windows-host-ip>:9223"
}
```

Enable `evaluate_js`:

```json
{
  "MCP_BROWSER_ENABLE_EVAL": "1"
}
```

## Commands

- `serve` runs the MCP broker over stdio
- `doctor [--url URL]` checks browser reachability, local display state, and optional page access
- `open <url>` launches a local browser with remote debugging enabled
- `relay` forwards TCP traffic, useful for Windows-to-WSL DevTools bridging
- `--help` and `help` print usage
- `--version` and `version` print the package version

Examples:

```bash
mbdt doctor
mbdt doctor --url http://127.0.0.1:3000
mbdt open http://127.0.0.1:3000 --family chromium
mbdt open about:blank --family firefox --user-data-dir /tmp/mbdt-firefox
mbdt relay --wsl
```

## Configuration

- `MCP_BROWSER_FAMILY` defaults to `chromium`; set `firefox` for Firefox BiDi
- `CDP_BASE_URL` defaults to `http://127.0.0.1:9222`
- `FIREFOX_BIDI_WS_URL` defaults to `ws://127.0.0.1:9222`; when pointed at the root Firefox remote debugging port, the broker first requests `webSocketUrl` from `POST /session` and then connects to the returned BiDi session socket
- `MCP_BROWSER_EVENT_BUFFER_SIZE` sets the per-session buffered event limit
- `MCP_BROWSER_ENABLE_EVAL=1` enables `evaluate_js`
- `MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1` allows non-loopback CDP or BiDi endpoints
- `MCP_BROWSER_ALLOW_REMOTE_CDP=1` is still accepted as a legacy alias
- `MCP_PROTOCOL_VERSION` overrides the advertised MCP protocol version

The `open` command also requires `MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1` before it will bind Chromium remote debugging to a non-loopback address.

The `relay` command defaults to `127.0.0.1:9223 -> 127.0.0.1:9222`. Non-loopback relay binds require either `--wsl` on Windows or `MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1`.

## Exposed Tools

- `browser_status`
- `list_tabs`
- `list_sessions`
- `attach_tab`
- `detach_tab`
- `get_page_state`
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

## Browser Notes

- Chromium uses the standard DevTools endpoints at `/json/version` and `/json/list`
- Firefox support expects a direct BiDi websocket endpoint
- In WSL, Linux browser executables are preferred before Windows fallback paths
- For Windows Chrome + WSL, prefer the `relay` command over changing Chrome's remote debugging bind

## Why Not Playwright?

Playwright is still the stronger choice for deterministic browser automation and end-to-end tests. It has a more mature locator model, assertions, waiting semantics, tracing, and CI story.

`mcp-browser-dev-tools` solves a different problem:

- it is MCP-native, so AI clients call a bounded tool surface instead of generating and executing Playwright scripts
- it attaches to an already-open browser tab and inspects the current session state, cookies, login state, extensions, console, and network history
- it is designed for local AI debugging workflows, including loopback-only defaults, opt-in evaluation, and the Windows-to-WSL relay path
- it presents one MCP interface across Chromium CDP and Firefox BiDi instead of requiring the AI client to know browser protocol details

Use Playwright when you want reproducible automation. Use this project when you want an AI assistant to inspect and manipulate a live browser session through MCP.

## Debugging Notes

- `attach_tab` now seeds network history from the Performance API so already-loaded pages still show useful requests
- console buffers include source URL, line and column where the browser reports them, plus stack frames when available
- `get_page_state` reports the current URL, title, viewport, and scroll position without enabling `evaluate_js`

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
- [Setup Guide](docs/setup.md)
- [Repository Settings](docs/repository-settings.md)
- [Publishing](PUBLISHING.md)
