# Releases

`CHANGELOG.md` is the single source for human-readable release notes. An approved GitHub Actions run publishes the npm package with provenance, then creates the matching Git tag and GitHub release from that changelog section. Stable versions use npm's `latest` tag; `X.Y.Z-alpha.N` uses `alpha`, and `X.Y.Z-beta.N` uses `beta`.

## Prepare and publish

1. Choose an unused version. Update `version` in `package.json` and `package-lock.json`, and set the matching `publishConfig.tag`.
2. Add a dated `## [VERSION]` section to `CHANGELOG.md`. Do not repeat release notes in the README or this procedure.
3. Run `npm run check` and `npm pack --dry-run`. Open and merge the reviewed change only after CI passes for Node 22, Node 24 and emulated ARMv7.
4. On `main`, manually run **Publish npm release** with `approved_version` set to the exact package version, then approve the protected `npm` environment.
5. Confirm the workflow completed both `publish` and `github-release`. The latter creates `vVERSION`, marks alpha/beta versions as prereleases and uses only the matching changelog section as its notes.

The workflow validates the semver shape, exact approval, npm access, registry, distribution tag and matching finished changelog section before it publishes. The approval input never changes files or bumps a version.

## Failure recovery

npm versions are immutable. If publication is uncertain, inspect npm before trying anything else. If `publish` succeeded but `github-release` failed, use GitHub's **Re-run failed jobs** action so only the release job runs again; do not start another publication. The GitHub release job is idempotent for a release that already targets the same commit and rejects a conflicting tag target.

## First publication

npm trusted publishing is configured per package, so the package must exist before the workflow can publish it. This follows the homebridge-centsys bootstrap:

1. The maintainer publishes the first unused version once from a clean checkout of `main` (`npm publish --tag alpha`, with two-factor authentication). `prepublishOnly` still requires `ATLAS_RELEASE_APPROVED` to equal the version and a finished changelog section. This first publication has no provenance attestation.
2. Configure the npm trusted publisher (below) and set `NPM_PUBLISH_ENABLED=true`.
3. Create the GitHub release for that first version from its changelog section (`node scripts/release-notes.mjs VERSION`) at the published commit. Later versions are released only through the workflow.

## Publisher configuration

- npm trusted publisher: GitHub owner `deanvanniekerk`, repository `homebridge-atlas`, workflow `release.yml`, environment `npm`.
- GitHub environment `npm`: restricted to `main`, with a required maintainer review.
- Repository variable `NPM_PUBLISH_ENABLED=true` enables publication. It stays `false` until the trusted publisher is configured.
- The publish job has `contents: read` and `id-token: write`; the subsequent GitHub release job has only `contents: write`.

## Homebridge verification

After the first npm publication and GitHub release, request verification with the [Plugin Verification Request](https://github.com/homebridge/plugins/issues/new/choose) template. The automated checks install the published package and require:

- `homepage`, `bugs.url`, the `homebridge-plugin` and `supports-hap` keywords, and no install scripts;
- `engines` compatible with Node 22, Node 24 and the latest Homebridge;
- a valid `config.schema.json` whose `pluginAlias` matches the registered platform;
- `homebridge` only as a development dependency;
- a public repository with issues enabled and at least one GitHub release, with the GitHub `package.json` version matching npm;
- clean startup with no configuration, only the platform, and minimal and full configurations; resilience to network failures; and exit within 12 seconds of SIGTERM.

Keep credentials and raw diagnostics out of release artifacts. Hardware evidence and limitations remain in [validation](VALIDATION.md), not release notes.
