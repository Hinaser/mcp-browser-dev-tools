# Publishing

This repository is structured as an npm CLI package with the package name `mcp-browser-dev-tools` and the preferred binary name `mbdt`.

## Before The First Public Release

- Confirm the final package name or scope is available on npm
- Fill in the final `license`, `repository`, `homepage`, `bugs`, and `author` fields in [`package.json`](package.json)
- Verify the README examples match the package name you plan to publish

## Release Checklist

1. Update `version` in [`package.json`](package.json).
2. Run `corepack enable` if pnpm is not already available.
3. Run `pnpm install --frozen-lockfile`.
4. Run `pnpm test`.
5. Run `pnpm run pack:check`.
6. Inspect the tarball contents and confirm only the intended runtime files are included.
7. Smoke test the packaged CLI locally if you changed commands or packaging behavior.
8. Publish with `npm publish`.
9. For prereleases such as `0.0.1-beta.0`, publish with the matching dist-tag such as `npm publish --tag beta`.
10. For a scoped public package, use `npm publish --access public` and include the prerelease tag when needed.

## Notes

- The published tarball is intentionally limited by the `files` field in [`package.json`](package.json).
- The root package export resolves to [`src/index.mjs`](src/index.mjs).
- Development and CI use `pnpm`; npm is still used for registry publishing and login flows.
- If the unscoped name `mcp-browser-dev-tools` is unavailable, publish under a scope such as `@your-scope/mcp-browser-dev-tools`.
- GitHub repository protections are described in [`docs/repository-settings.md`](docs/repository-settings.md).
