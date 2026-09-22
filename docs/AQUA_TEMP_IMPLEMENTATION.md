# Aqua Temp alignment implementation spec

This is an implementation plan for [`homebridge-aqua-temp`](https://github.com/deanvanniekerk/homebridge-aqua-temp), whose published package is **`homebridge-aqua-temp-connect`**. Use [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) as the common standard. The device-specific behavior in [Aqua Temp's architecture document](https://github.com/deanvanniekerk/homebridge-aqua-temp/blob/main/docs/ARCHITECTURE.md) remains authoritative.

## Starting point and scope

Inspected the local `codex/typescript-1.0.3` working tree on 22 September 2026, plus the fetched `origin/main`. The working tree already has uncommitted work converting `test/*.test.mjs` to `test/*.test.mts`, adding `tsconfig.test.json`, and updating package scripts. Preserve or finish that work before applying this plan; do not overwrite it. The current package uses strict NodeNext TypeScript for production, Node's test runner, ESLint, Prettier, Ajv for a schema parity test, and a small custom `scripts/build.mjs`. It has no runtime dependencies. CI checks Node 22/24 and emulated ARMv7.

The alignment changes are structural and tooling changes. Keep the existing cloud protocol, device behavior, Homebridge identities, release process, and public configuration contract.

## Target layout

```text
src/
  index.ts                         Homebridge registration only
  settings.ts                      Plugin/platform names, UUID namespace, version
  configuration.ts                 Zod config schema and safe parseConfig
  configuration.test.ts
  cloud/
    cloud-client.ts                 Authentication, retry and request budgets
    cloud-http.ts                   Bounded HTTP transport and envelope validation
    cloud-protocol.ts               Login/session and request/command wire shapes
    cloud-time.ts                   Clock and deadline handling
    cloud-error.ts                  Fixed safe cloud error categories
    cloud-client.test.ts            Former cloud.test.mts scenarios
    cloud-http.test.ts              Transport-specific scenarios if splitting helps
    fake-cloud.test-support.ts
    redirect-cloud.test-support.ts
  device/
    device-model.ts                 Discovery, telemetry, capabilities, commands
    gateway.ts                      Cloud-to-device translation and preflight
    coordinator.ts                  Freshness, polling, reconciliation
    command-queue.ts                Per-device serialization and deadlines
    scheduler.ts                    Real/fake timing seam
    diagnostics.ts                  Sanitized account/device reporting
    *.test.ts                       Tests beside each owner
    fake-scheduler.test-support.ts
  homebridge/
    platform.ts                     Lifecycle, selection, cache and UUIDs
    thermostat.ts                   Thermostat HAP presentation
    basic-accessory.ts              Optional read-only sensor presentation
    *.test.ts                       Real HAP behavior tests
scripts/
  check-release.mjs
  check-release.test.ts             Former release.test.mts
  check-armv7.sh
  release-notes.mjs
docs/
  PROJECT_STRUCTURE.md             Adapted copy of the common guide
```

Keep `config.schema.json`, protocol fixtures, CI/release workflows, and user documentation at their present locations. Do not add an empty `homebridge-ui/` area: Aqua Temp has no custom settings server. The three implementation areas are `cloud/`, `device/`, and `homebridge/`; they correspond to Atlas's cloud, site, and Homebridge areas without copying Atlas-specific names.

| Existing file | Target | Responsibility to preserve |
| --- | --- | --- |
| `src/cloud-{client,http,protocol,time,error}.ts` | `src/cloud/` with the same basenames | Cloud request/session rules, deadlines and safe categories |
| `src/{device-model,gateway,coordinator,command-queue,scheduler,diagnostics}.ts` | `src/device/` | Observed state and commands, independent of HAP |
| `src/{platform,thermostat,basic-accessory}.ts` | `src/homebridge/` | Stable accessory IDs and HAP presentation |
| `src/{index,settings,configuration}.ts` | Remain in `src/` | Entrypoint and shared config/identity |

Move files with `git mv`, update `.js` import specifiers for NodeNext, and keep `src/index.ts` as the published `dist/index.js` entrypoint. Update moved tests' relative paths to `config.schema.json`, `fixtures/protocol/` and release scripts; check paths from the compiled `dist/` layout as well as from `src/`. Do not create barrels or pass-through classes solely to match a diagram. The gateway satisfies the coordinator's existing `DeviceGateway` interface; the scheduler is a real test seam. Cloud code must not import Homebridge; device code must not import HAP.

## Validation and dependencies

Add Zod as a **runtime** dependency. Put each schema beside the module that owns the untrusted input:

- `src/configuration.ts`: preserve every current default and validation edge: required username/password, 1–64 character name, at most 100 unique device IDs, 30–300 integer poll interval, and three independent sensor flags. Preserve the parser's Unicode code-point length checks when expressing them in Zod. Keep `parseConfig(unknown)` and `ConfigurationError` as the public module interface. Translate Zod issues into the existing fixed field messages; never log submitted credentials or raw issues. Retain `config.schema.json` for Homebridge UI and keep the Ajv parity test as a dev-only check.
- `src/cloud/cloud-protocol.ts`: validate credentials, login session, read requests and command envelopes. Preserve the vendor's exact spellings and rules, including `x-token`, `userId`, `appId`, `user_id` agreement and bounded command arrays.
- `src/cloud/cloud-http.ts`: validate the HTTP success envelope while retaining its 64 KiB request, 1 MiB response, timeout, redirect, retry and safe-error behavior. Parsing with Zod must not weaken the check that `error_code`, `isReusltSuc` and `objectResult` agree.
- `src/device/device-model.ts`: use Zod for bounded, unknown vendor record shapes where it clarifies decoding. Keep per-reading `missing`/`invalid`/`conflict` results and unknown states; do not turn optional malformed telemetry into failure of unrelated fields. Avoid a second global `schemas/` or `zod/` directory.

Align the quality stack with Atlas's pinned baseline: Biome `2.5.14`, Vitest `5.0.1`, Vite `7.3.6` (Vitest's dev-time transformer), Zod `4.6.5`, and rimraf `6.1.3`. Keep TypeScript, Homebridge and Node types already present; keep Ajv while the UI/runtime schema parity test uses it. Remove ESLint, `@eslint/js`, `typescript-eslint`, `globals`, Prettier and their config files after Biome is configured. Commit the lockfile. A shared version update across all three plugins can follow later; these versions document the current Atlas template, not a claim that they are the newest releases.

Use `biome.json` with 2-space indentation, 100-column lines, single-quoted JavaScript/TypeScript, trailing commas, import organization and Git ignore integration. Cover TypeScript, JavaScript, JSON, Markdown where supported, and fixture JSON without reformatting evidence in a way that changes its meaning. Keep explicit excludes for generated `dist/`, coverage, local secrets and the lockfile where appropriate.

Replace `scripts/build.mjs` with the same unbundled Node ESM build used by Atlas:

```json
{
  "build": "rimraf dist && tsc -p tsconfig.json",
  "typecheck": "tsc --noEmit",
  "lint": "biome lint .",
  "format": "biome format --write .",
  "format:check": "biome format .",
  "test": "vitest run",
  "check:runtime": "npm run typecheck && npm run build && npm test",
  "check": "biome check . && npm run check:runtime",
  "prepack": "npm run build"
}
```

Keep existing release scripts and `prepublishOnly`. Update `package.json` `files` from `dist/*.js` to **`dist/**/*.js`** so nested runtime modules ship. Exclude tests and `.test-support.ts` from the production `tsconfig.json` emit; keep strict production settings. If the in-progress `tsconfig.test.json` is retained, adapt it to colocated `.test.ts` paths and make its typecheck a real passing gate; do not keep a stale `test/**/*.mts` include. Do not make Vite the production build: this plugin needs NodeNext output and no browser bundle.

## Tests and CI migration

Convert the in-progress `.mts` tests to `.test.ts`, import source modules directly, and use Vitest `test`, `expect` and lifecycle hooks. Move each file beside the behavior it exercises:

| Current test | New owner |
| --- | --- |
| `configuration` | `src/configuration.test.ts` |
| `cloud` | `src/cloud/cloud-client.test.ts`; place transport-only cases in `cloud-http.test.ts` if useful |
| `device-model` | `src/device/device-model.test.ts` |
| `gateway` | `src/device/gateway.test.ts` |
| `coordinator`, `commands`, `control-recovery`, `mode-controls` | `src/device/coordinator*.test.ts` or `command-queue.test.ts` according to the actual seam exercised |
| `diagnostics` | `src/device/diagnostics.test.ts` |
| `platform`, `thermostat`, `basic-accessory` | Matching files in `src/homebridge/` |
| `release` | `scripts/check-release.test.ts` |
| `fake-cloud`, `redirect-cloud`, `fake-scheduler` | Matching `.test-support.ts` files beside their users |

Use `vitest.config.ts` to discover `src/**/*.test.ts` and `scripts/**/*.test.ts`. Keep file isolation or serial execution for tests that replace process-wide transport functions. Preserve the existing local fake HTTP server, virtual clock, real HAP checks and schema-parity cases. Do not dilute the no-write-replay, stale-data, command readback, accessory-cache or mode-change assertions merely to complete the framework migration. Add a package-content check after the moves because unit tests that import source cannot prove the npm tarball contains every nested compiled module.

On x64 CI, run `npm ci` and `npm run check`. On ARMv7, run `npm run check:runtime` because the Atlas Biome version has no ARMv7 executable. Change the Docker script to call that runtime check; otherwise its current `npm run check` would fail for a tooling-platform reason. Keep the release workflow's existing checks and approval gates.

## Contracts and acceptance

- Preserve `PLUGIN_NAME = homebridge-aqua-temp-connect`, `PLATFORM_NAME = AquaTemp`, and the private `ACCESSORY_NAMESPACE` UUID seed. Keep accessory context, optional sensor roles and retirement of older Power/Water identities intact.
- Preserve the observed CRM wire format, owned/shared discovery, profile evidence policy, bounded reads, no write replay, strict mode-specific targets, fresh preflight and matching readback. Keep unknown compressor activity unknown in the device model.
- Preserve config defaults, field errors and the Homebridge UI schema. Zod adoption must not silently coerce strings/numbers or broaden accepted vendor data.
- A clean install passes Biome, production TypeScript, build and Vitest on supported x64 Node versions; emulated ARMv7 passes runtime checks. `npm pack --dry-run --json` contains nested compiled JavaScript, necessary docs and schema, and excludes tests, fixtures, local secrets and dev tools.
- The public README and `docs/ARCHITECTURE.md` describe the new paths and commands; a local `docs/PROJECT_STRUCTURE.md` records the shared conventions for future changes.
