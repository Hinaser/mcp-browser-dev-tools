# mcp-browser-dev-tools

`mcp-browser-dev-tools` is a local MCP server that lets AI clients inspect browser state through Chromium DevTools Protocol or Firefox WebDriver BiDi.

It is designed for a local trust boundary:

`AI client -> MCP over stdio -> local broker -> browser adapter -> page target`

## What You Get

- A stdio MCP server for local desktop and terminal clients
- Browser discovery and attach/detach for Chromium-family browsers and Firefox
- Read-oriented tools for DOM inspection, element lookup, console messages, network requests, screenshots, tab listing, and buffered events
- Optional JavaScript evaluation behind an explicit environment flag
- Helper commands to check browser connectivity and launch a debug-enabled browser

## Requirements

- Node.js `22+`
- A local browser exposing either CDP or BiDi
- Loopback endpoints by default; remote endpoints require an explicit opt-in flag

## Install

One-off execution with `npx`:

```bash
npx -y mcp-browser-dev-tools serve
```

Global install:

```bash
npm install -g mcp-browser-dev-tools
mcp-browser-dev-tools serve
```

Project-local install:

```bash
npm install mcp-browser-dev-tools
npx mcp-browser-dev-tools serve
```

## MCP Client Configuration

Generic stdio client configuration:

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

For Firefox, switch `MCP_BROWSER_FAMILY` to `firefox` and set `FIREFOX_BIDI_WS_URL`.

## Commands

- `serve` runs the MCP broker over stdio
- `doctor [--url URL]` checks browser reachability, local display state, and optional page access
- `open <url>` launches a local browser with remote debugging enabled
- `--help` and `help` print usage
- `--version` and `version` print the package version

Examples:

```bash
mcp-browser-dev-tools doctor
mcp-browser-dev-tools doctor --url http://127.0.0.1:3000
mcp-browser-dev-tools open http://127.0.0.1:3000 --family chromium
```

## Configuration

- `MCP_BROWSER_FAMILY` defaults to `chromium`; set `firefox` for Firefox BiDi
- `CDP_BASE_URL` defaults to `http://127.0.0.1:9222`
- `FIREFOX_BIDI_WS_URL` defaults to `ws://127.0.0.1:9222`
- `MCP_BROWSER_EVENT_BUFFER_SIZE` sets the per-session buffered event limit
- `MCP_BROWSER_ENABLE_EVAL=1` enables `evaluate_js`
- `MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1` allows non-loopback CDP or BiDi endpoints
- `MCP_BROWSER_ALLOW_REMOTE_CDP=1` is still accepted as a legacy alias
- `MCP_PROTOCOL_VERSION` overrides the advertised MCP protocol version

## Exposed Tools

- `browser_status`
- `list_tabs`
- `list_sessions`
- `attach_tab`
- `detach_tab`
- `get_console_messages`
- `get_network_requests`
- `get_document`
- `inspect_element`
- `take_screenshot`
- `get_events`

`evaluate_js` is intentionally disabled by default. Enable it only when you want the broker to allow page-side code execution.

For tools that take `sessionId`, call `attach_tab` first and reuse the returned session.

## Browser Notes

- Chromium uses the standard DevTools endpoints at `/json/version` and `/json/list`
- Firefox support expects a direct BiDi websocket endpoint
- In WSL, Linux browser executables are preferred before Windows fallback paths

## Safety Defaults

- The broker only allows loopback browser endpoints unless you opt in
- The default tool surface is read-focused
- Arbitrary page evaluation is opt-in
- Clients interact with a bounded MCP tool surface instead of raw browser protocol calls

## Development

```bash
npm test
npm run pack:check
```

Additional docs:

- [Architecture](docs/architecture.md)
- [Repository Settings](docs/repository-settings.md)
- [Publishing](PUBLISHING.md)
