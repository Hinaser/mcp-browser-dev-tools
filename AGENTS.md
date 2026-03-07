# AGENTS.md

## Project

- Package name: `mcp-browser-dev-tools`
- Purpose: local MCP server that bridges AI clients to Chromium CDP and Firefox BiDi
- Runtime: Node.js `24+`, ESM-only
- Package manager for development and CI: `pnpm`

## Core Commands

- `pnpm run check`: lint, format check, and tests
- `pnpm run pack:check`: verify npm tarball contents
- `pnpm test`: run the Node test suite

## Release And GitHub Rules

- Use signed commits.
- Publish is tag-driven only: pushing `v*` tags triggers npm publish.
- The publish workflow must not reintroduce `workflow_dispatch`.
- The publish job is gated by the `npm-release` environment.
- The repository is intended to keep these GitHub protections enabled:
  - signed commits on all branches
  - protected `main`
  - protected `v*` tags
  - squash merge disabled

Version-controlled ruleset definitions live in `.github/rulesets/`.

## Security Invariants

- Keep browser endpoints loopback-only by default.
- Do not allow non-loopback `open --address` unless `MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1`.
- Keep arbitrary page evaluation behind `MCP_BROWSER_ENABLE_EVAL`.
- Keep inbound JSON-RPC/stdin message size bounded.
- Prefer trusted publishing over long-lived npm tokens.
- Keep `package-lock.json` out of the repo; `pnpm-lock.yaml` is the canonical lockfile.

## Public Repo Hygiene

- Do not commit local absolute filesystem paths.
- Do not add maintainer-local review helpers or private workflow scratch files back into the repo.
- `.codex-reviews/` is local-only and must stay ignored.
- Keep the npm package surface small; only runtime files belong in the published tarball.

## Current Repository Shape

- Public docs: `README.md`, `docs/architecture.md`, `docs/repository-settings.md`, `PUBLISHING.md`
- Maintainer scripts: `scripts/`
- Runtime source: `src/`
- GitHub automation: `.github/workflows/`
- Repo ruleset definitions: `.github/rulesets/`
