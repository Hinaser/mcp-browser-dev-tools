# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this file starts tracking
changes from the point it was introduced rather than reconstructing older
release history retroactively.

## [Unreleased]

## [0.0.5] - 2026-03-14

### Added

- `MCP_BROWSER_LOG_FILE` environment variable to write all log output to a file in addition to stderr, useful for diagnosing crashes when the MCP client captures stderr inconsistently

## [0.0.4] - 2026-03-14

### Added

- Auto-dismiss JavaScript dialogs (`alert`, `confirm`, `prompt`) on attached CDP and Firefox BiDi sessions to prevent page-blocking modals from stalling the broker connection and causing MCP clients to deregister all tools
- Dialog events are captured in the session event buffer as `kind: "dialog"` entries so callers can observe that a dialog appeared even though it was auto-dismissed
- Firefox BiDi sessions now subscribe to `browsingContext.userPromptOpened` and `browsingContext.userPromptClosed` events
- Crash diagnostics: `uncaughtException` and `unhandledRejection` handlers log full stack traces to stderr before exit, and a `process.exit` handler logs non-zero exit codes — all with `force: true` so they appear regardless of the configured log level

## [0.0.3] - 2026-03-12

### Added

- `MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS=1` to expose an `unsafeArgs` array on `launch_browser` and `ensure_browser` for opt-in browser flag passthrough without allowing broker-managed launch flags to be overridden

### Changed

- remove the npm beta badge from the README header now that the stable release line is current

## [0.0.2] - 2026-03-11

This stable release rolls up the `0.0.2-beta.0` and `0.0.2-beta.1`
prerelease changes below and adds the following final changes.

### Added

- `get_cookies` and `get_storage` MCP tools for bounded session-scoped cookie and storage inspection
- `capture_debug_report` for one-shot page state, storage summary, console, network, and screenshot capture
- `get_har` for bounded HAR-like exports from buffered session network activity
- `compare_page_state` and `compare_selector` for bounded cross-session and cross-browser checks
- `capture_session_snapshot` and `restore_session_snapshot` for bounded same-origin cookie and storage restore workflows
- loopback auto-discovery for default CDP and Firefox BiDi endpoints across ports `9222` through `9226`
- `launch_browser` MCP tool so agents can start a compatible local debug-enabled browser through the broker
- `ensure_browser` MCP tool so agents can make browser startup and initial tab creation a single workflow step
- `serve --bootstrap-wsl-relay` so a WSL broker can start the Windows-side CDP relay automatically before adapter startup

### Changed

- `MCP_BROWSER_FAMILY` now defaults to `auto` so agents can choose the browser family at runtime instead of starting in Chromium-only mode
- Chromium-family launches now auto-create a temporary profile when an already-running browser process would otherwise swallow the new debug flags

## [0.0.2-beta.1] - 2026-03-11

### Changed

- add npm version, beta, and download badges to the README header

## [0.0.2-beta.0] - 2026-03-11

### Added

- `new_tab` and `close_tab` MCP tools for browser tab lifecycle management
- `wait_for` MCP tool for selector, URL, and ready-state waits on attached sessions
- MIT `LICENSE` file and package license metadata
- changelog tracking for future releases
- `MCP_BROWSER_LOG_LEVEL` and `MCP_BROWSER_DEBUG_STDIO` for stderr-only broker diagnostics
