# Releases

`CHANGELOG.md` is the single source for release notes. An approved GitHub Actions run publishes the npm package with provenance, then creates the matching Git tag and GitHub release. Stable versions use npm's `latest` tag; `X.Y.Z-alpha.N` uses `alpha` and `X.Y.Z-beta.N` uses `beta`.

The package is `private` until the first publication decision; the release guard refuses to publish while it is.

## Prepare and publish

1. Choose an unused version. Update `version` in `package.json` and `package-lock.json`, and set the matching `publishConfig.tag`.
2. Add a dated `## [VERSION]` section to `CHANGELOG.md`.
3. Run `npm run check` and `npm pack --dry-run`. Merge only after CI passes for Node 22, Node 24 and emulated ARMv7.
4. On `main`, run **Publish npm release** with `approved_version` set to the exact package version, then approve the protected `npm` environment.

## Publisher configuration

- npm trusted publisher: owner `deanvanniekerk`, repository `homebridge-atlas`, workflow `release.yml`, environment `npm`.
- GitHub environment `npm`: restricted to `main`, with a required maintainer review.
- Repository variable `NPM_PUBLISH_ENABLED=true` enables publication.

npm versions are immutable. If publication is uncertain, inspect npm before retrying; re-run only the failed GitHub release job.
