# Setup Guide

This guide is for manually verifying that `mcp-browser-dev-tools` can reach a browser debugging endpoint before you wire it into an MCP client.

Use the prerelease package name while the project is still beta:

```bash
npx -y mcp-browser-dev-tools@beta --help
```

If you install the package globally or project-locally, use `mbdt` as the CLI command.

## Windows (PowerShell)

Chrome and Edge often ignore `--remote-debugging-port` when an existing browser process is reused. The safest path is to use a dedicated profile directory. If the browser still reuses an existing session, close the browser normally and retry.

```powershell
npx -y mcp-browser-dev-tools@beta open about:blank --family chromium --user-data-dir "$env:TEMP\mcp-browser-dev-tools-profile"
```

For Firefox:

```powershell
npx -y mcp-browser-dev-tools@beta open about:blank --family firefox --user-data-dir "$env:TEMP\mcp-browser-dev-tools-firefox"
```

For Edge in `auto` mode alongside Firefox, use a separate CDP port:

```powershell
npx -y mcp-browser-dev-tools@beta open about:blank --family edge --port 9223 --user-data-dir "$env:TEMP\mcp-browser-dev-tools-edge"
```

What you want to see:

- `open` prints `launched chromium browser: ...`
- the doctor summary printed by `open` reports `adapter available: true`

If you also want to verify your app endpoint:

```powershell
npx -y mcp-browser-dev-tools@beta doctor --url http://localhost:3000
```

If `open` fails to report `adapter available: true`, use the raw endpoint check as troubleshooting:

```powershell
Invoke-WebRequest http://127.0.0.1:9222/json/version | Select-Object -Expand Content
```

## WSL Using A Windows Browser

This is the boundary case that usually needs the most explanation.

Recommended flow for generic browser access:

1. Launch Chrome or Edge on the Windows side with the normal loopback DevTools endpoint.
2. Run `relay` on Windows so WSL can reach a boundary port.
3. Point the WSL MCP server at the relay.
4. Use mirrored networking only if you prefer changing WSL networking globally.

Recommended flow for Codex in WSL:

1. Launch the browser on Windows.
2. Run the MCP broker on Windows too.
3. Let Codex talk to that broker over stdio.

For Codex, running the broker on Windows is simpler than relaying browser sockets back into WSL.

### Launch Chrome On Windows

Use PowerShell on Windows, or call it from WSL through `powershell.exe` if you prefer.

```powershell
npx -y mcp-browser-dev-tools@beta open about:blank --family chromium --user-data-dir "$env:TEMP\mcp-browser-dev-tools-profile"
```

### Launch Firefox Or Edge On Windows

Firefox:

```powershell
npx -y mcp-browser-dev-tools@beta open http://localhost:3000 --family firefox --user-data-dir "$env:TEMP\mcp-browser-dev-tools-firefox"
```

Edge with a dedicated CDP port:

```powershell
npx -y mcp-browser-dev-tools@beta open http://localhost:3000 --family edge --port 9223 --user-data-dir "$env:TEMP\mcp-browser-dev-tools-edge"
```

If you use `MCP_BROWSER_FAMILY=auto`, keep Firefox on `9222` and use `9223` for Chrome or Edge.

### Start The Relay On Windows

In a second Windows terminal:

```powershell
npx -y mcp-browser-dev-tools@beta relay --wsl
```

Expected output:

```text
relay listening on <windows-wsl-host-ip>:9223 -> 127.0.0.1:9222
for WSL use: CDP_BASE_URL=http://<windows-wsl-host-ip>:9223
```

`--wsl` binds the relay to the Windows WSL virtual interface instead of exposing it on every network interface.

### Verify From WSL Through The Relay

From WSL:

```bash
WINDOWS_HOST=$(ip route show | awk '/default/ { print $3; exit }')
curl "http://${WINDOWS_HOST}:9223/json/version"
MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1 \
CDP_BASE_URL="http://${WINDOWS_HOST}:9223" \
npx -y mcp-browser-dev-tools@beta doctor --url https://google.com
```

What you want to see:

- `curl` returns the usual DevTools JSON payload
- `doctor` reports `adapter available: true`

### Why Use The Relay

Normal headful Windows Chrome or Edge keeps the DevTools listener on loopback. In practice that means WSL NAT cannot reach it directly through the Windows host IP, even if Chrome was launched with a non-loopback debugging address. The relay solves that without changing Chrome's own bind address.

### Alternative: Mirrored Networking

If you prefer not to run a relay process, mirrored mode is the alternative:

In `%UserProfile%\.wslconfig` on Windows:

```ini
[wsl2]
networkingMode=mirrored
```

Then restart WSL from PowerShell:

```powershell
wsl --shutdown
```

After restarting WSL, use loopback directly:

```bash
curl http://127.0.0.1:9222/json/version
npx -y mcp-browser-dev-tools@beta doctor --url https://google.com
```

Mirrored mode changes WSL networking globally. The relay is narrower in scope.

### WSL Browser Selection Note

When you run `open` inside WSL, the tool prefers Linux browser executables before Windows fallback paths. If you explicitly want the Windows browser, launch it from the Windows side.

### Codex In WSL With A Windows Browser

If Codex runs in WSL but the browser runs on Windows, point Codex at a Windows-side broker instead of running the broker inside WSL.

Example `~/.codex/config.toml` entry for Firefox on Windows:

```toml
[mcp_servers.browser-devtools]
startup_timeout_sec = 30
command = "/mnt/c/nvm4w/nodejs/node.exe"
args = ["-e", "process.env.MCP_BROWSER_FAMILY='firefox';process.env.FIREFOX_BIDI_WS_URL='ws://127.0.0.1:9222';import('//wsl.localhost/<wsl-distro>/<repo-wsl-path>/src/cli.mjs').then(({ runCli }) => runCli(['serve'])).catch((error) => { console.error(error?.stack || String(error)); process.exit(1); });"]
```

Example `auto` mode entry for Firefox plus Chrome or Edge:

```toml
[mcp_servers.browser-devtools]
startup_timeout_sec = 30
command = "/mnt/c/nvm4w/nodejs/node.exe"
args = ["-e", "process.env.MCP_BROWSER_FAMILY='auto';process.env.CDP_BASE_URL='http://127.0.0.1:9223';process.env.FIREFOX_BIDI_WS_URL='ws://127.0.0.1:9222';import('//wsl.localhost/<wsl-distro>/<repo-wsl-path>/src/cli.mjs').then(({ runCli }) => runCli(['serve'])).catch((error) => { console.error(error?.stack || String(error)); process.exit(1); });"]
```

Replace `<wsl-distro>` and `<repo-wsl-path>` with your own values.

Why this works:

- Firefox and Edge keep their loopback debugging sockets on Windows
- the broker runs on Windows and connects to those sockets directly
- Codex still launches the broker from WSL over stdio

After updating `config.toml`, restart Codex so it respawns the MCP server with the new command.

## Linux

If Chrome or Chromium is installed on Linux, the built-in `open` flow is usually enough:

```bash
npx -y mcp-browser-dev-tools@beta open https://google.com --family chromium --user-data-dir "$HOME/.cache/mcp-browser-dev-tools-profile"
npx -y mcp-browser-dev-tools@beta doctor --url https://google.com
```

## macOS

Use the same flow as Linux, but with a macOS-installed Chromium-family browser:

```bash
npx -y mcp-browser-dev-tools@beta open https://google.com --family chromium --user-data-dir "$HOME/Library/Caches/mcp-browser-dev-tools-profile"
npx -y mcp-browser-dev-tools@beta doctor --url https://google.com
```

## After The Smoke Test

Once `doctor` shows `adapter available: true`, point your MCP client at a stdio server command:

```bash
npx -y mcp-browser-dev-tools@beta serve
```

If you already installed the package, use:

```bash
mbdt serve
```

The most common client-specific examples are:

Codex:

```bash
codex mcp add browser-devtools \
  --env MCP_BROWSER_FAMILY=chromium \
  --env CDP_BASE_URL=http://127.0.0.1:9222 \
  -- npx -y mcp-browser-dev-tools@beta serve
```

Claude Code:

```bash
claude mcp add browser-devtools --scope user \
  --env MCP_BROWSER_FAMILY=chromium \
  --env CDP_BASE_URL=http://127.0.0.1:9222 \
  -- npx -y mcp-browser-dev-tools@beta serve
```

Cursor:

```json
{
  "mcpServers": {
    "browser-devtools": {
      "command": "npx",
      "args": ["-y", "mcp-browser-dev-tools@beta", "serve"]
    }
  }
}
```

For Firefox, switch `MCP_BROWSER_FAMILY` to `firefox` and set `FIREFOX_BIDI_WS_URL`. For Microsoft Edge, switch `MCP_BROWSER_FAMILY` to `edge` and keep using `CDP_BASE_URL`. For `auto` mode, use separate ports for CDP and Firefox. For WSL relay usage, set `MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1` and point `CDP_BASE_URL` at the relay port.

`serve` stays attached to stdio, so it should run in its own terminal or be spawned directly by the MCP client. More complete client examples live in [README.md](../README.md).
