# Architecture

## Runtime Shape

The broker sits between an MCP client and a locally reachable browser debugging endpoint:

`AI client -> MCP over stdio -> broker -> Chromium CDP or Firefox BiDi -> page`

The package is intentionally local-first. The browser protocol stays on the machine that runs the MCP server, and the client only sees a constrained tool surface.

## Main Components

### CLI

The CLI provides three user-facing entrypoints:

- `serve` for the MCP server
- `doctor` for environment and endpoint checks
- `open` for launching a local browser with debugging enabled
- `relay` for forwarding TCP traffic across a local machine boundary such as Windows Chrome to WSL

### MCP Broker

`McpBrowserDevToolsServer` handles JSON-RPC framing over stdio, advertises the tool list, validates tool arguments, and returns structured tool results.

### Browser Adapters

The adapter layer hides protocol-specific details behind a shared interface:

- `CdpSessionManager` for Chromium-family browsers, including Microsoft Edge
- `FirefoxBidiSessionManager` for Firefox
- `MultiBrowserAdapter` for `MCP_BROWSER_FAMILY=auto`, which multiplexes both behind one broker

Each adapter owns target discovery, session attachment, event buffering, screenshots, DOM retrieval, and optional evaluation.

Both adapters also share a page-context helper that implements locator parsing and DOM-side actions such as inspect, click, type, select, scroll, and page-state reads.

In `auto` mode the broker namespaces external ids as `chromium:<id>` and `firefox:<id>` so one MCP connection can address both backends without ambiguity. Edge also uses the CDP-backed `chromium:` namespace in `auto` mode because it shares the same adapter family.

## Tool Design

The broker exposes stable, task-oriented MCP tools instead of raw protocol methods:

- `browser_status`
- `list_tabs`
- `new_tab`
- `close_tab`
- `list_sessions`
- `attach_tab`
- `detach_tab`
- `get_page_state`
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

`evaluate_js` exists behind `MCP_BROWSER_ENABLE_EVAL=1` because it changes the trust model from inspection to execution.

## Protocol Mapping

### Chromium

- Browser metadata comes from `/json/version`
- Page targets come from `/json/list`
- Each attached tab gets its own debugger websocket
- The session enables `Page`, `Runtime`, `DOM`, `Log`, and `Network`
- Navigation and viewport overrides map to `Page.navigate`, `Page.reload`, and `Emulation.setDeviceMetricsOverride`
- Element screenshots use the normalized locator result plus `Page.captureScreenshot` clipping

### Firefox

- The broker opens one BiDi websocket to the configured endpoint
- `browsingContext.getTree` provides page targets
- `session.subscribe` attaches event streams per context
- `script.evaluate` provides shared locator and action behavior
- `browsingContext.navigate`, `browsingContext.reload`, `browsingContext.setViewport`, and `browsingContext.captureScreenshot` cover page control and screenshots

## Safety Model

- Loopback-only browser endpoints by default
- Read-oriented tools enabled by default
- Explicit opt-in for evaluation
- The relay command stays loopback-only by default unless you explicitly bind it differently
- Bounded in-memory event buffers per session
- Adapter-specific normalization before data is returned to the MCP client

## Packaging

The package ships as a Node.js CLI with no build step. The npm tarball contains the runtime source and README, and the root package export exposes a small programmatic API for embedding or testing.
