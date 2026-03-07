# Repository Settings

This repository uses GitHub Actions for CI and tag-based npm publishing, but signed-commit enforcement belongs in GitHub repository rulesets.

## Required GitHub Ruleset For `main`

Create a branch ruleset that targets `refs/heads/main` and enable these protections:

- Require a pull request before merging
- Require status checks to pass before merging
- Require signed commits
- Block force pushes
- Block branch deletion

Use the `verify` job from the `CI` workflow as the required status check.

## Signed Commits For PR Branches

If you want every pushed branch to require signed commits, add a second branch ruleset that targets `refs/heads/*` with `Require signed commits`.

If you only protect `main`, unsigned commits will still be blocked from landing on `main`, which is enough for many smaller repositories.

## Merge Method Recommendation

GitHub's signed-commit protections interact poorly with squash merges because GitHub creates the squash commit on your behalf.

Recommended repository settings:

- Enable merge commits or rebase merges
- Disable squash merges unless the PR author is expected to perform the squash merge themselves

## npm Publish Workflow

The `Publish` workflow runs when a tag matching `v*` is pushed. It checks that the tag matches the version in `package.json` and then publishes to npm.

Recommended authentication setup:

1. Configure npm trusted publishing for this GitHub repository.
2. Keep the workflow permission `id-token: write` enabled.

If you prefer token-based publishing instead, create an `NPM_TOKEN` repository secret with publish access to the npm package.
