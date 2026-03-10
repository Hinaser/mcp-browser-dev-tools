# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this file starts tracking
changes from the point it was introduced rather than reconstructing older
release history retroactively.

## [Unreleased]

### Future Plan

- cookies and storage inspection tools
- auto-discovery of loopback browser debug endpoints
- one-shot debug bundle capture for screenshot, console, network, and page state
- session snapshot export and bounded restore workflows
- cross-browser comparison tools for bounded page state and selector checks
- richer network export formats such as HAR-style summaries

## [0.0.2-beta.0] - 2026-03-11

### Added

- `new_tab` and `close_tab` MCP tools for browser tab lifecycle management
- `wait_for` MCP tool for selector, URL, and ready-state waits on attached sessions
- MIT `LICENSE` file and package license metadata
- changelog tracking for future releases
- `MCP_BROWSER_LOG_LEVEL` and `MCP_BROWSER_DEBUG_STDIO` for stderr-only broker diagnostics
