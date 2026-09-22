# CENTSYS alignment implementation spec

This is an implementation plan for [`homebridge-centsys`](https://github.com/deanvanniekerk/homebridge-centsys). Use [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) as the common standard, adapted to CENTSYS's MQTT control, persisted authentication and custom settings wizard. Its [validation record](https://github.com/deanvanniekerk/homebridge-centsys/blob/main/docs/VALIDATION.md) remains the source for hardware evidence and unverified behavior.

## Starting point and scope

Inspected the local `codex/typescript-ui-1-1-3` working tree on 22 September 2026, plus the fetched `origin/main`. The working tree has uncommitted work moving the browser wizard from `homebridge-ui/public/app.js` to `homebridge-ui/app.ts` and adding `tsconfig.ui.json`. Preserve or finish that migration before applying this plan. The runtime already uses strict NodeNext TypeScript, `mqtt`, `proper-lockfile` and `@homebridge/plugin-ui-utils`. Tests use Node's test runner and a separate `test/` directory; formatting uses Prettier. Production build already uses `tsc` for Node and browser output. CI checks Node 22/24 and emulated ARMv7.

This plan aligns code ownership, validation, tests, formatting and packaging. It must not alter gate actuation, authentication, storage, accessory identity, setup behavior or the claims supported by physical testing.

## Target layout

```text
src/
  index.ts                         Homebridge registration only
  ui-server.ts                     Homebridge settings server entrypoint
  cli.ts                           Owner-only diagnostic CLI entrypoint
  prepare-auth.ts                  Owner-only auth preparation entrypoint
  settings.ts                      Plugin/platform identity and storage path
  configuration.ts                 Zod config schema and safe parseConfig
  errors.ts                        Shared fixed error codes and safe diagnostics
  configuration.test.ts
  cloud/
    client.ts                       HTTPS/OTP requests and response envelopes
    bootstrap.ts                    Bootstrap request
    cloud-protocol.ts               HTTPS vendor shapes and decoders
    mqtt-codec.ts                   Binary MQTT packet and telemetry codec
    mqtt-session.ts                 MQTT lifecycle and live proof
    *.test.ts                       Transport and codec tests
    *.test-support.ts               Local fake HTTP/MQTT helpers, if shared
  auth/
    storage.ts                      Owner-only files and versioned session JSON
    session-lock.ts                 Cross-process session lease
    *.test.ts
  setup/
    setup.ts                        OTP/setup workflow and wizard requests
    mac-setup.ts                    Validated Wi-Fi address candidate
    *.test.ts
  gate/
    gate-model.ts                   Normalized device/overview/state types
    gateway.ts                      Session-aware HTTPS/MQTT orchestration
    coordinator.ts                  Freshness, command serialization, readback
    diagnostics.ts                  Safe gate reports
    *.test.ts
  homebridge/
    platform.ts                     Lifecycle, cache, UUIDs and HAP presentation
    platform.test.ts
homebridge-ui/
  app.ts                            Browser wizard source
  app.test.ts                       Wizard tests beside its source
  server.js                         Loads dist/ui-server.js
  public/                           index.html, style.css, built app.js
scripts/
  check-release.mjs
  check-release.test.ts
  check-armv7.sh
  release-notes.mjs
resources/
  centsys-ca.crt                    Pinned certificate used by MQTT
docs/
  PROJECT_STRUCTURE.md             Adapted copy of the common guide
```

Keep the root entrypoints thin. `settings.ts` should retain the public constants and `storageDirectory`; move its configuration parser and `GateConfig`/`CentsysConfig` types to `configuration.ts`. Keep `errors.ts` at the root because cloud, auth, setup, gate and Homebridge all use its fixed safe categories.

| Existing file | Target | Responsibility to preserve |
| --- | --- | --- |
| `src/{client,bootstrap,mqtt-codec,mqtt-session}.ts` | `src/cloud/` | Vendor transports and binary contract |
| `src/protocol.ts` | `src/cloud/cloud-protocol.ts` and `src/gate/gate-model.ts` | Move wire validation and normalized state/types to their respective owners; avoid a mechanical split that creates cycles |
| `src/{storage,session-lock}.ts` | `src/auth/` | Private storage and process lease shared by setup/runtime |
| `src/{setup,mac-setup}.ts` | `src/setup/` | Wizard workflows and identity verification |
| `src/{gateway,coordinator,diagnostics}.ts` | `src/gate/` | Fresh live state and command reconciliation |
| `src/platform.ts` | `src/homebridge/platform.ts` | Garage HAP presentation and stable UUIDs |
| `src/settings.ts` parser | `src/configuration.ts` | Config parsing; identity constants remain in settings |
| `src/{index,ui-server,cli,prepare-auth,errors,settings}.ts` | Remain at `src/` root | Public/runtime entrypoints and shared contracts |

Use `git mv`, update NodeNext `.js` import specifiers and keep the published entrypoint at `dist/index.js`. Audit all URLs relative to `import.meta.url` after moving files: `mqtt-session.ts` must still load the packaged root `resources/centsys-ca.crt`, and `auth/storage.ts` must still use the intended root `.local/auth/` default for CLI work. Update moved tests' references to compiled modules, scripts and package metadata. The gate coordinator's `Gateway` interface is an existing real seam; the gateway owns the HTTPS/MQTT/auth composition. The auth store and lease are shared by setup and runtime. Keep vendor code free of Homebridge/HAP imports. Only extract a separate garage presentation module if it gives the platform a smaller interface; a one-line forwarding class adds no value.

## Validation and dependencies

Add Zod as a **runtime** dependency and colocate schemas with the input they validate:

- `src/configuration.ts`: validate `pollInterval` 10–300, diagnostic flag, at most 10 unique gate serials, optional protocol MAC, name and supported `controlProfile`. Preserve the runtime's current distinction between a **new gate selected in the wizard** (UI defaults control on) and a raw/saved configuration with missing `enableControl` (runtime treats it as off). Preserve serial/MAC normalization, the requirement for protocol MAC and supported profile when control is enabled, and the fixed `CentsysError('configuration')` on failure. Keep `config.schema.json` as the Homebridge UI schema; test parity and intentional UI/runtime differences.
- `src/cloud/cloud-protocol.ts`: validate unknown HTTPS response envelopes, discovery rows, overview rows, credentials, region and serial fields without broadening the accepted wire shapes. Keep unknown state unknown and discovery/overview bounds. `src/cloud/client.ts` should surface only the established safe errors.
- `src/auth/storage.ts`: validate the versioned `session.json` and owner-only operator JSON after the existing symlink, size and permission checks. Keep private-file atomic writes and `session-lock.ts`; Zod validates content, not filesystem security.
- `src/setup/setup.ts` and `src/ui-server.ts`: validate unknown IPC request payloads at the setup operations that own them. Preserve fixed response shapes and safe `RequestError` codes. Keep schemas beside those handlers, with no central `zod/` folder.
- Keep `src/cloud/mqtt-codec.ts` as explicit bounded binary parsing. Zod is useful for object data, not a replacement for byte-level protocol and live-telemetry proof rules.

Align tool versions with Atlas's pinned baseline: Biome `2.5.14`, Vitest `5.0.1`, Vite `7.3.6` for dev-time Vitest transforms, Zod `4.6.5`, and rimraf `6.1.3`. Retain `mqtt`, `proper-lockfile`, `@homebridge/plugin-ui-utils` and their needed types. Remove Prettier and its config after Biome is in place. Commit the updated lockfile. These are template versions, not a claim that they are the newest releases.

Use the same `biome.json` conventions as Atlas: 2 spaces, 100-column lines, single-quoted JavaScript/TypeScript, trailing commas, import organization and Git ignore integration. Format the browser source and static CSS/HTML where Biome supports them. Exclude generated `dist/`, `homebridge-ui/public/app.js`, coverage, `.local/` and private files. Do not format or publish raw owner validation captures merely for consistency.

Retain `tsc` as the production build for both Node ESM and the unbundled browser script. The current `tsconfig.ui.json` emits `homebridge-ui/public/app.js`; keep that path and `homebridge-ui/server.js` unchanged. Use rimraf only to remove stale generated output before both compilers:

```json
{
  "build": "rimraf dist homebridge-ui/public/app.js && tsc -p tsconfig.json && tsc -p tsconfig.ui.json",
  "typecheck": "tsc --noEmit && tsc -p tsconfig.ui.json --noEmit",
  "lint": "biome lint .",
  "format": "biome format --write .",
  "format:check": "biome format .",
  "test": "vitest run",
  "check:runtime": "npm run typecheck && npm run build && npm test",
  "check": "biome check . && npm run check:runtime",
  "prepack": "npm run build"
}
```

Keep `prepare:auth`, `diagnose`, release scripts and `prepublishOnly`. Exclude colocated tests and `.test-support.ts` from the production `tsconfig.json`; the browser config already includes only `homebridge-ui/app.ts`. Change package `files` from `dist/*.js` to **`dist/**/*.js`**, and list `homebridge-ui/server.js` and `homebridge-ui/public/` explicitly so `app.ts`/`app.test.ts` do not ship. Preserve `resources/centsys-ca.crt`, notices, docs and current CLI outputs until their published use is reviewed. Vite is for Vitest; a Vite application bundle adds no value to this small wizard.

## Tests and CI migration

Convert `test/*.test.mjs` to colocated `.test.ts` files and import source TypeScript directly through Vitest. Move coverage by the module's interface rather than by a broad test category:

| Current test | New owner |
| --- | --- |
| `client` | `src/cloud/client.test.ts` and `cloud-protocol.test.ts` |
| `mqtt` | `src/cloud/mqtt-codec.test.ts` and `mqtt-session.test.ts` |
| `storage` and session lease portions of `mac-setup` | `src/auth/storage.test.ts`, `session-lock.test.ts` |
| `setup`, Wi-Fi candidate portions of `mac-setup` | `src/setup/setup.test.ts`, `mac-setup.test.ts` |
| `gateway`, `coordinator` | Matching files in `src/gate/` |
| `platform`, configuration cases in `errors` | `src/homebridge/platform.test.ts`, `src/configuration.test.ts`; error formatting in `src/errors.test.ts` |
| `setup-ui` | `homebridge-ui/app.test.ts` |
| `release` | `scripts/check-release.test.ts` |

Use `vitest.config.ts` to discover `src/**/*.test.ts`, `homebridge-ui/**/*.test.ts` and `scripts/**/*.test.ts`. Preserve fake HTTPS/MQTT servers, synthetic identity data, real HAP checks, the DOM/Homebridge wizard simulation, and release-guard tests. The wizard test can execute transformed `app.ts` with a fake `window`/`document`, then independently smoke-check the emitted `public/app.js`; it need not add a browser bundler or change the shipped page. Keep tests that mutate global state or bind fixed ports isolated. Retain test cases for the one-shot QoS 0 trigger, no uncertain replay, live MQTT proof versus cached HTTPS, 45-second expiry, OTP/session persistence, secure file permissions, supported profile gating, and restoration of saved control-off settings.

On x64 CI, run `npm ci` and `npm run check`. On ARMv7, have `scripts/check-armv7.sh` run `npm run check:runtime` because the Atlas Biome binary is unavailable there. Preserve the current release workflow and approvals. Add a tarball check: source tests passing does not prove nested emitted files, browser script or CA certificate are published.

## Contracts and acceptance

- Keep `PLUGIN_NAME = homebridge-centsys`, `PLATFORM_NAME = Centsys`, the `centsys:gate:${serialNumber}` UUID seed, saved configuration names and Homebridge `GarageDoorOpener` characteristic behavior. Cached accessories must show unavailable until live state is verified.
- Keep MQTT live proof independent from potentially cached HTTPS overview, the supported South African D5 Evo SMART+ control profile, address verification and account lease. No startup or retry path may actuate a gate; an ambiguous trigger outcome is reconciled from telemetry.
- Keep `session.json` version 1, storage path, owner-only permissions, atomic writes, local logout behavior, and the custom UI IPC paths. No credential, serial, MAC or raw vendor response may reach logs or repository fixtures.
- The wizard still builds to `homebridge-ui/public/app.js`; existing users can sign in, verify an address, save a new gate with control on, reopen an existing control-off gate without changing it, and configure diagnostics independently.
- A clean install passes Biome, both TypeScript projects, build and Vitest on supported x64 Node versions; emulated ARMv7 passes runtime checks. `npm pack --dry-run --json` includes nested runtime JavaScript, the compiled wizard, loader, certificate, schema and required notices, while excluding test/source browser files, local secrets and raw research captures.
- Update README and validation/development docs to show the new paths and commands. Keep physical-device evidence and remaining unknowns stated accurately; tooling migration alone does not establish additional gate safety or reliability.
