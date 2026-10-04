# CLAUDE.md

This repository's canonical agent memory is in `AGENTS.md`. Keep both files aligned.

## Project Snapshot

- `mcp-browser-dev-tools` is a local MCP server for Chromium CDP and Firefox BiDi.
- Node.js `24+`, ESM-only.
- Main verification command: `pnpm run check`
- Development and CI use `pnpm`.

## Non-Negotiables

- Signed commits.
- Tag-only npm publish from `v*` tags.
- No `workflow_dispatch` publish path.
- `npm-release` environment gate for publish.
- Loopback-only browser/debug endpoints by default.
- `evaluate_js` and `expression` conditions are on by default; `MCP_BROWSER_ENABLE_EVAL=0` turns both off.
- `upload_file` reads only from the working directory, the temp directory, and `MCP_BROWSER_UPLOAD_DIRS`.
- `.codex-reviews/` stays ignored and local-only.
- `pnpm-lock.yaml` is the canonical lockfile.

## Public Repo Hygiene

- No local absolute paths.
- No maintainer-only review helper scripts.
- Keep published npm contents limited to runtime files plus README.

## Pointers

- Repo memory and conventions: `AGENTS.md`
- Public usage docs: `README.md` (overview), `docs/tools.md` (tool reference), `docs/configuration.md` (clients and settings)
- Benchmark method, scenarios, and results: `PERFORMANCE.md`
- GitHub protection model: `docs/repository-settings.md`
