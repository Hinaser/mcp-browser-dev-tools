# CLAUDE.md

This repository's canonical agent memory is in `AGENTS.md`. Keep both files aligned.

## Project Snapshot

- `mcp-browser-dev-tools` is a local MCP server for Chromium CDP and Firefox BiDi.
- Node.js `22+`, ESM-only.
- Main verification command: `npm run check`

## Non-Negotiables

- Signed commits.
- Tag-only npm publish from `v*` tags.
- No `workflow_dispatch` publish path.
- `npm-release` environment gate for publish.
- Loopback-only browser/debug endpoints by default.
- `MCP_BROWSER_ENABLE_EVAL` stays opt-in.
- `.codex-reviews/` stays ignored and local-only.

## Public Repo Hygiene

- No local absolute paths.
- No maintainer-only review helper scripts.
- Keep published npm contents limited to runtime files plus README.

## Pointers

- Repo memory and conventions: `AGENTS.md`
- Public usage docs: `README.md`
- GitHub protection model: `docs/repository-settings.md`
