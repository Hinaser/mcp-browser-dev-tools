# Repository Settings

This repository uses GitHub Actions for CI and tag-based npm publishing, but signed-commit enforcement belongs in GitHub repository rulesets.

Version-controlled ruleset definitions live in [`.github/rulesets`](../.github/rulesets).

## Required GitHub Ruleset For `main`

Create a branch ruleset that targets `refs/heads/main` and enable these protections:

- Require a pull request before merging
- Require status checks to pass before merging
- Require signed commits
- Block force pushes
- Block branch deletion

Use the `verify` job from the `CI` workflow as the required status check.

If the repository has not been pushed yet, create this ruleset after the first push to `main` so the required status check context already exists.

## Signed Commits For PR Branches

If you want every pushed branch to require signed commits, add a second branch ruleset that targets `refs/heads/*` with `Require signed commits`.

If you only protect `main`, unsigned commits will still be blocked from landing on `main`, which is enough for many smaller repositories.

## Merge Method Recommendation

GitHub's signed-commit protections interact poorly with squash merges because GitHub creates the squash commit on your behalf.

Recommended repository settings:

- Enable merge commits or rebase merges
- Disable squash merges unless the PR author is expected to perform the squash merge themselves

## Required Tag Ruleset

Create a tag ruleset that targets `refs/tags/v*` and enable these protections:

- Restrict tag creation
- Restrict tag updates
- Restrict tag deletion

Add an admin bypass actor only for the people who are allowed to create release tags.

## npm Publish Workflow

The `Publish` workflow runs only when a tag matching `v*` is pushed. It checks that the tag matches the version in `package.json` and then publishes to npm from the `npm-release` environment.

Recommended authentication setup:

1. Configure npm trusted publishing for this GitHub repository.
2. Create the `npm-release` environment.
3. Add yourself as the required reviewer for that environment.
4. Keep the workflow permission `id-token: write` enabled.
