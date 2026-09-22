# Homebridge plugin project structure

This guide describes the layout and coding conventions of `homebridge-atlas`. It is also a starting point for aligning other small Homebridge plugins. Copy the principles and adapt the folders to the responsibilities that actually exist in each plugin; do not copy Atlas-specific modules into a plugin that does not need them.

## Repository map

```text
.
├── src/
│   ├── index.ts                  Homebridge registration entrypoint
│   ├── ui-server.ts              Homebridge settings server entrypoint
│   ├── diagnose.ts               Owner-run, read-only diagnostic entrypoint
│   ├── configuration.ts          Parse and validate plugin configuration
│   ├── settings.ts               Plugin identity and package version
│   ├── cloud/                    Vendor protocol, HTTP, events, errors and deadlines
│   ├── site/                     Panel model, gateway, scheduling and coordination
│   └── homebridge/               Platform lifecycle and HAP accessories
├── homebridge-ui/
│   ├── server.js                 Loads the compiled settings server
│   └── public/                   Settings page assets
├── test/                         Behavioral tests and local fake cloud/scheduler
├── scripts/                      Build, release and architecture checks
├── docs/                         Maintainer and user documentation
├── .github/workflows/            CI and release pipelines
├── config.schema.json            Homebridge settings schema
├── biome.json                    Formatter, linter and import organization
├── tsconfig.json                 Strict TypeScript compilation
└── package.json                  Entry points, scripts and published files
```

The root of `src/` contains stable entrypoints and cross-cutting configuration. Group implementation files by responsibility once a group is large enough to make navigation easier. Folder names describe what code owns, not an arbitrary layer such as `utils/` or `services/`.

## Module responsibilities and dependencies

| Area | Owns | May depend on |
| --- | --- | --- |
| `cloud/` | Vendor wire contract, authentication, bounded HTTP/SSE transport, safe error categories and time budgets | Node APIs and its own modules |
| `site/` | Decoded panel state, the cloud-to-panel gateway, polling/push coordination, command confirmation and diagnostics | `cloud/` and cross-cutting configuration |
| `homebridge/` | Homebridge lifecycle, accessory identity and HAP characteristic presentation | `site/`, `cloud/` error categories and configuration |
| Root entrypoints | Registration, settings server, owner diagnostics | The modules each entrypoint needs |

Keep dependencies pointed toward the behavior they use. In particular, cloud code should not know about Homebridge or HAP, and site coordination should not know about HAP characteristics. The gateway implements the coordinator's `PanelGateway` interface; tests can provide a fake gateway or scheduler at those seams. Keep an interface where there is a real alternate implementation or where it hides substantial complexity for callers.

Do not add barrel files just to shorten paths. Direct imports reveal module ownership and make navigation easier in a small repository. A large cohesive module can be clearer than several thin pass-through files; split it when the pieces have distinct responsibilities and an interface that reduces what callers must know.

## Runtime and package contracts

- `src/index.ts` compiles to `dist/index.js`, the `main`/`exports` entrypoint Homebridge loads. Keep it small: it registers the platform.
- `homebridge-ui/server.js` loads `dist/ui-server.js`. The compiled settings server handles requests; `homebridge-ui/public/` holds browser assets. Settings discovery uses the same validated cloud and panel code as the runtime.
- `config.schema.json` describes the settings UI; `src/configuration.ts` is the runtime validation authority. Update both when configuration changes.
- `src/diagnose.ts` is a local, read-only developer command. It is built for `npm run diagnose` and deliberately excluded from the npm package.
- TypeScript emits the same directory structure under `dist/`. The package includes `dist/**/*.js` so imports from nested modules work. Inspect `npm pack --dry-run --json --ignore-scripts` after changing the source layout.
- A Homebridge restart must preserve accessory identities. Move files freely, but treat plugin/platform names, UUID inputs, persisted context and external configuration as contracts.

## Tests and quality checks

Tests live under `test/` and import compiled JavaScript from `dist/`. A test should exercise the seam that owns the behavior: client tests use a local fake HTTP server, coordination tests use a fake gateway and scheduler, and presentation tests use Homebridge/HAP objects. Fake responses and identities are synthetic; no real credentials or panel identifiers belong in the repository.

Use these commands in every plugin, with scripts adapted to its runtime:

```sh
npm ci
npm run format         # Apply Biome formatting
npm run check          # Biome, TypeScript and behavioral tests
npm pack --dry-run --json --ignore-scripts
```

`biome.json` is the single formatter and linter configuration. Biome checks TypeScript, JavaScript, JSON and CSS here; `tsc --noEmit` supplies type and other compiler checks. Pin tool versions and commit the lockfile. CI should run the same checks as local development. This repository's ARMv7 runtime job runs `npm run check:runtime` because Biome has no ARMv7 executable; x64 CI runs the full Biome check.

## Readability conventions

- Put types beside the behavior that defines them. Export only types and functions another module actually uses.
- Decode vendor data from `unknown` before it enters the site model. Preserve unavailable states rather than guessing missing or unfamiliar values.
- Keep transport errors in fixed, safe categories; do not leak vendor responses, credentials or private panel data into logs.
- Make deadlines, cancellation, retries and command confirmation explicit. A transport acknowledgement is not a confirmed panel state.
- Keep Homebridge getters free of network calls. The coordinator owns freshness and publishes snapshots for accessories to present.
- Prefer descriptive names and short comments that explain invariants or safety decisions. Avoid comments that only restate the next line of code.
- Keep side effects at entrypoints and resource-owning modules. Close streams, timers and subscriptions when Homebridge shuts down.
- Preserve strict TypeScript settings and run Biome before review. An intentional lint exception should have a local reason, not a broad folder-wide disable.

## Applying this to another plugin

1. Identify its public contracts: Homebridge registration, UI server, config schema, package files, accessory UUIDs and stored context.
2. Draw the actual dependency flow from vendor transport to normalized state to Homebridge presentation. Create folders only for responsibilities present in that plugin.
3. Keep the entrypoints thin and separate vendor-specific code from Homebridge code. Put configuration validation at the input edge.
4. Align scripts and CI on Biome, strict TypeScript and behavioral tests. Use a runtime-only check on architectures for which Biome publishes no binary.
5. After moving files, update relative imports, compiled test imports, documentation and package file globs. Verify `npm run check` and inspect the npm tarball before publishing.

For this plugin's protocol decisions and runtime behavior, see [Architecture](ARCHITECTURE.md). Those details are specific to Atlas/RISCO Cloud and are not a template for other devices.
