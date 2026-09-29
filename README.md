# mcp-browser-dev-tools

[![npm version](https://img.shields.io/npm/v/mcp-browser-dev-tools?label=npm)](https://www.npmjs.com/package/mcp-browser-dev-tools)
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
- Wait conditions for selector visibility, element text, URL changes, and document ready state
- Batched steps that run several actions and checks in one call, with `if`/`else` branches on the page state
- One-shot debug bundle capture for page state, storage summary, recent console, recent network, and screenshots
- JavaScript evaluation in the page, on by default and removable with an environment flag
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

Both `ensure_browser` and `launch_browser` try to keep one browser running instead of starting more:

- a browser that is already reachable is reused, whatever profile it runs on; `launch_browser` returns `reused: true` instead of launching when `port`, `address`, `userDataDir`, and `unsafeArgs` are all omitted, and opens `url` in a new tab of that browser
- before reusing or launching, the browser status is checked three times, so one slow answer does not trigger a launch
- after launching, the broker will not launch the same browser again for 30 seconds while it waits for the endpoint, and launches are handled one at a time, so parallel tool calls do not start one browser each
- on macOS and Linux, the broker never launches a second browser on a profile that is already open (or, for Firefox without `userDataDir`, while any Firefox is running), because that only opens another window in the running browser; it waits for that browser's endpoint instead, and fails with an explanation if the endpoint stays down. On Windows and WSL the broker cannot read browser command lines, so it cannot detect which profile a running Chrome or Edge uses; the Firefox check and the automatic temporary Chrome/Edge profile still apply there

To make every launch use the same profile, set `MCP_BROWSER_USER_DATA_DIR` in the MCP server environment instead of passing `userDataDir` on every call. It applies only when a browser actually has to be launched; a browser that is already reachable is reused as is.

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

Disable `evaluate_js`:

```json
{
  "MCP_BROWSER_ENABLE_EVAL": "0"
}
```

Enable unsafe browser launch args for `launch_browser` and `ensure_browser`:

```json
{
  "MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS": "1"
}
```

If you use WSL with a Windows Chrome or Edge browser, prefer `serve --bootstrap-wsl-relay` in the configured args instead of manually wiring `relay`. If you use Windows Firefox from WSL, or `auto` mode with both Windows Firefox and Windows Chrome or Edge, run the broker on Windows instead. Full examples are in [docs/setup.md](docs/setup.md).

## Advanced Environment Options

- `MCP_BROWSER_FAMILY` defaults to `auto`; set `chromium`, `edge`, or `firefox` to pin the broker to one browser family
- `CDP_BASE_URL` defaults to `http://127.0.0.1:9222`; when left at that default the broker probes loopback ports `9222` through `9226` for a reachable CDP browser endpoint
- `FIREFOX_BIDI_WS_URL` defaults to `ws://127.0.0.1:9222`; when left at that default the broker probes loopback ports `9222` through `9226`, and when pointed at the root Firefox remote debugging port it connects to the `/session` websocket and creates a BiDi session there
- in `auto` mode, assign CDP and Firefox different ports so both browsers can run at once
- `MCP_BROWSER_USER_DATA_DIR` sets the browser profile directory that `ensure_browser` and `launch_browser` use when `userDataDir` is not passed; a leading `~/` expands to the home directory
- `MCP_BROWSER_EVENT_BUFFER_SIZE` sets the per-session buffered event limit
- `MCP_BROWSER_LOG_LEVEL` controls diagnostic logging to `stderr`: `error`, `warn`, `info`, or `debug`
- `MCP_BROWSER_DEBUG_STDIO=1` emits raw MCP stdio transport diagnostics to `stderr`
- `MCP_BROWSER_ENABLE_EVAL=0` (or `false`) disables `evaluate_js`, which is enabled by default
- `MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS=1` exposes the `unsafeArgs` launch option on `launch_browser` and `ensure_browser`
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
  When `MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS=1`, this tool also accepts `unsafeArgs` as an array of browser flags. Broker-managed launch flags such as the debug port and profile path still cannot be overridden.
- `launch_browser`
  Launches a local debug-enabled browser that matches the current broker configuration and can return an inline doctor report
  In `auto` mode, pass `browserFamily`
  For Chrome or Edge launches, `userDataDir` is optional; if omitted, the broker auto-creates a temporary profile when an already-running browser process makes that necessary
  When `MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS=1`, this tool also accepts `unsafeArgs` as an array of browser flags. Broker-managed launch flags such as the debug port and profile path still cannot be overridden.
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
- `run_steps`

`evaluate_js` is enabled by default, as page evaluation is in most browser MCP servers. Set `MCP_BROWSER_ENABLE_EVAL=0` to remove it from the tool list. Treat that as a way to narrow the tool surface, not as a security boundary: the other tools already read page content, cookies, and storage and can navigate anywhere, and any local process that reaches the debugging port can evaluate code through the browser protocol directly. To control page-side code execution per call, use your MCP client's tool permissions.

Unsafe browser launch flags are also disabled by default. If you enable `MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS=1`, pass only full flag strings such as `--remote-allow-origins=http://localhost:9222`. It still does not let callers replace broker-managed launch flags like `--remote-debugging-port` or `--user-data-dir`.

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

`output` changes how the image comes back. `image` returns an MCP image content block, with only the metadata in the JSON. `file` writes the decoded image to a file and returns its `path` instead of base64 data; passing `path` implies `file`. `path` must be absolute and end in `.png`, `.jpg`, `.jpeg`, or `.webp` (not `.webp` on Firefox), which also sets the format; missing parent directories are created. An existing file is only replaced with `overwrite: true`, and a symlink at `path` is replaced rather than written through. Without `path`, the image goes to a new private directory under the system temp directory. Files are created readable only by the current user. Without `output` or `path`, `take_screenshot` returns base64 data as before.

### Batched Steps

`run_steps` runs several session tools in order in one call, so an action and the check of its result take one round trip instead of several:

```json
{
  "sessionId": "chromium:session-1",
  "steps": [
    { "tool": "click", "arguments": { "selector": "text=Save" } },
    { "tool": "sleep", "arguments": { "ms": 300 } },
    { "tool": "take_screenshot" }
  ]
}
```

Any tool that takes `sessionId` can be a step, with its arguments minus `sessionId`, plus `sleep` (`ms`, at most 30000). Up to 50 steps are validated before any of them runs. A step fails when its tool throws or reports `found: false` for a missing element (`inspect_element` excepted, since it may be checking that an element is gone). The call stops at the first failing step unless `continueOnError` is true, and reports each step's result or error. Screenshots come back as image content blocks instead of base64 text; the step result keeps the metadata and an `image` field with the 1-based position of its image.

An `if` step branches on the page state without a round trip back to the client:

```json
{
  "tool": "if",
  "arguments": {
    "condition": { "selector": "#status", "textIncludes": "failed" },
    "then": [{ "tool": "click", "arguments": { "selector": "text=Retry" } }],
    "elseIf": [
      {
        "condition": { "urlIncludes": "/login" },
        "then": [
          { "tool": "take_screenshot", "arguments": { "output": "image" } }
        ]
      }
    ],
    "else": [{ "tool": "get_page_state" }]
  }
}
```

Each condition takes the same fields as `wait_for` (`selector` with `state`, `textEquals`, `textIncludes`, plus `url`, `urlIncludes`, `readyState`), and all given fields must hold. `condition` and then each `elseIf` entry are checked in order, once and without waiting, and the first one that holds runs its `then`; `else` runs when none does. Put a `wait_for` or `sleep` step first if the page may still be changing. Every branch is validated up front, the 50-step limit counts steps inside branches, and an `if` placed inside a branch nests at most 4 levels deep. The `if` result reports the `branch` taken (`then`, `elseIf[i]`, or `else`), each condition it `checked` with what was observed (URL, whether the element was found and visible, its text), and the branch's step results; a failing step inside a branch fails the `if` and stops the batch like any other step.

Text conditions compare the element's visible text with whitespace collapsed, and only its first 400 characters are read: `textIncludes` does not see text past that point, and `textEquals` never matches an element with longer text.

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
- it is designed for local AI debugging workflows, including loopback-only defaults and the Windows-to-WSL relay path
- it presents one MCP interface across Chromium CDP and Firefox BiDi instead of requiring the AI client to know browser protocol details

Use Playwright when you want reproducible automation. Use this project when you want an AI assistant to inspect and manipulate a live browser session through MCP.

## Debugging Notes

- `attach_tab` now seeds network history from the Performance API so already-loaded pages still show useful requests
- console buffers include source URL, line and column where the browser reports them, plus stack frames when available
- `get_page_state` reports the current URL, title, viewport, and scroll position without enabling `evaluate_js`
- broker diagnostics write to `stderr` so `stdout` stays reserved for MCP protocol traffic

## Safety Defaults

- The broker only allows loopback browser endpoints unless you opt in
- Tools can both read and act on the page: they click, type, navigate, and run page JavaScript through `evaluate_js`, using whatever session the browser profile is signed in to, so point the broker at a profile you are willing to let an agent use
- `evaluate_js` can be removed from the tool surface with `MCP_BROWSER_ENABLE_EVAL=0`
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
