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

Recommended flow:

1. Launch Chrome or Edge on the Windows side with the normal loopback DevTools endpoint.
2. Run `relay` on Windows so WSL can reach a boundary port.
3. Point the WSL MCP server at the relay.
4. Use mirrored networking only if you prefer changing WSL networking globally.

### Launch Chrome On Windows

Use PowerShell on Windows, or call it from WSL through `powershell.exe` if you prefer.

```powershell
npx -y mcp-browser-dev-tools@beta open about:blank --family chromium --user-data-dir "$env:TEMP\mcp-browser-dev-tools-profile"
```

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

Once `doctor` shows `adapter available: true`, point your MCP client at:

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

`serve` stays attached to stdio, so it should run in its own terminal or be spawned directly by the MCP client.
