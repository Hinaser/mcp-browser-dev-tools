# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this file starts tracking
changes from the point it was introduced rather than reconstructing older
release history retroactively.

## [Unreleased]

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
