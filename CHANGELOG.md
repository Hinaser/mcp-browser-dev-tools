# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this file starts tracking
changes from the point it was introduced rather than reconstructing older
release history retroactively.

## [Unreleased]

### Added

- `get_cookies` and `get_storage` MCP tools for bounded session-scoped cookie and storage inspection
- `capture_debug_report` for one-shot page state, storage summary, console, network, and screenshot capture
- `get_har` for bounded HAR-like exports from buffered session network activity
- `compare_page_state` and `compare_selector` for bounded cross-session and cross-browser checks
- `capture_session_snapshot` and `restore_session_snapshot` for bounded same-origin cookie and storage restore workflows

### Future Plan

- auto-discovery of loopback browser debug endpoints

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
