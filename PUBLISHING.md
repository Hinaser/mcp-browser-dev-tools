# Publishing

This repository is structured as an npm CLI package with the binary name `mcp-browser-dev-tools`.

## Before The First Public Release

- Confirm the final package name or scope is available on npm
- Fill in the final `license`, `repository`, `homepage`, `bugs`, and `author` fields in [`package.json`](package.json)
- Verify the README examples match the package name you plan to publish

## Release Checklist

1. Update `version` in [`package.json`](package.json).
2. Run `npm test`.
3. Run `npm run pack:check`.
4. Inspect the tarball contents and confirm only the intended runtime files are included.
5. Smoke test the packaged CLI locally if you changed commands or packaging behavior.
6. Publish with `npm publish`.
7. For a scoped public package, use `npm publish --access public`.

## Notes

- The published tarball is intentionally limited by the `files` field in [`package.json`](package.json).
- The root package export resolves to [`src/index.mjs`](src/index.mjs).
- If the unscoped name `mcp-browser-dev-tools` is unavailable, publish under a scope such as `@your-scope/mcp-browser-dev-tools`.
