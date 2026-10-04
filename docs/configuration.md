# Configuration

How to register the server in each MCP client, how it finds or launches a browser, and every environment variable. For platform-specific walkthroughs (Windows, WSL with a Windows browser, Linux, macOS), see [Manual Verification And Troubleshooting](setup.md).

## MCP Clients

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

## Browser Launching And Profiles

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

## Common Variants

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

If you use WSL with a Windows Chrome or Edge browser, prefer `serve --bootstrap-wsl-relay` in the configured args instead of manually wiring `relay`. If you use Windows Firefox from WSL, or `auto` mode with both Windows Firefox and Windows Chrome or Edge, run the broker on Windows instead. Full examples are in [docs/setup.md](setup.md).

## Environment Variables

- `MCP_BROWSER_FAMILY` defaults to `auto`; set `chromium`, `edge`, or `firefox` to pin the broker to one browser family
- `CDP_BASE_URL` defaults to `http://127.0.0.1:9222`; when left at that default the broker probes loopback ports `9222` through `9226` for a reachable CDP browser endpoint
- `FIREFOX_BIDI_WS_URL` defaults to `ws://127.0.0.1:9222`; when left at that default the broker probes loopback ports `9222` through `9226`, and when pointed at the root Firefox remote debugging port it connects to the `/session` websocket and creates a BiDi session there
- in `auto` mode, assign CDP and Firefox different ports so both browsers can run at once
- `MCP_BROWSER_UPLOAD_DIRS` lists more directories `upload_file` may read files from, separated by `:` (`;` on Windows). Without it, `upload_file` reads only from the server's working directory and the system temp directory. Paths are compared after resolving symlinks, so a link inside an allowed directory cannot point outside it. This keeps a page that prompts the agent from getting it to upload files such as SSH keys
- `MCP_BROWSER_USER_DATA_DIR` sets the browser profile directory that `ensure_browser` and `launch_browser` use when `userDataDir` is not passed; a leading `~/` expands to the home directory
- `MCP_BROWSER_EVENT_BUFFER_SIZE` sets the per-session buffered event limit
- `MCP_BROWSER_LOG_LEVEL` controls diagnostic logging to `stderr`: `error`, `warn`, `info`, or `debug`
- `MCP_BROWSER_LOG_FILE` names a file that also receives every diagnostic line logged at that level
- `MCP_BROWSER_DEBUG_STDIO=1` emits raw MCP stdio transport diagnostics to `stderr`
- `MCP_BROWSER_TIMING_LOG` names a file that gets one JSON line per tool call with the tool name, duration, success, and response size (text characters and image count); the benchmark in [PERFORMANCE.md](../PERFORMANCE.md) uses it
- `MCP_BROWSER_TOOLS` chooses the tools the server offers. By default it offers the core set, the 24 tools page work needs, since every model turn pays for the definitions of every tool offered. Set it to `all`, or to a comma-separated list of groups (`input`, `network`, `state`, `compare`, `browser`, `performance`) and tool names to add to the core set, for example `network,drag`; the groups are listed in [Tools](tools.md#tool-sets). An unknown name stops the server at startup
- `MCP_BROWSER_ENABLE_EVAL=0` (or `false`) disables `evaluate_js` and the `expression` field of `wait_for` and `run_steps` conditions, which are enabled by default
- `MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS=1` exposes the `unsafeArgs` launch option on `launch_browser` and `ensure_browser`
- `MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1` allows non-loopback CDP or BiDi endpoints
- `MCP_BROWSER_ALLOW_REMOTE_CDP=1` is still accepted as a legacy alias
- `MCP_BROWSER_WINDOWS_NODE` optionally overrides the Windows `node` executable used by `serve --bootstrap-wsl-relay`
- `MCP_PROTOCOL_VERSION` overrides the advertised MCP protocol version

Unsafe browser launch flags are disabled by default. If you enable `MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS=1`, pass only full flag strings such as `--remote-allow-origins=http://localhost:9222`. It still does not let callers replace broker-managed launch flags like `--remote-debugging-port` or `--user-data-dir`.

## Browser Notes

- Chromium uses the standard DevTools endpoints at `/json/version` and `/json/list`
- Firefox support expects a direct BiDi websocket endpoint
- In WSL, Linux browser executables are preferred before Windows fallback paths
- For Windows Chrome or Edge + WSL, prefer the broker-managed relay path over changing the browser's remote debugging bind
