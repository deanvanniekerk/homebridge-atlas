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
│   ├── configuration.test.ts     Configuration tests beside the parser
│   ├── settings.ts               Plugin identity and package version
│   ├── cloud/                    Vendor protocol, transport and colocated tests
│   ├── site/                     Panel model, coordination and colocated tests
│   └── homebridge/               Platform, HAP accessories and colocated tests
├── homebridge-ui/
│   ├── server.js                 Loads the compiled settings server
│   └── public/                   Settings page assets and app.test.ts
├── scripts/                      Release/architecture checks and colocated tests
├── docs/                         Maintainer and user documentation
├── .github/workflows/            CI and release pipelines
├── config.schema.json            Homebridge settings schema
├── biome.json                    Formatter, linter and import organization
├── vitest.config.ts              Colocated test discovery and isolation
├── tsconfig.json                 Strict runtime TypeScript compilation
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
- `config.schema.json` describes the settings UI; the Zod schema in `src/configuration.ts` is the runtime validation authority. Update both when configuration changes.
- `src/diagnose.ts` is a local, read-only developer command. It is built for `npm run diagnose` and deliberately excluded from the npm package.
- `npm run build` uses `rimraf` and `tsc` to emit the same source directory structure under `dist/`. Vite transforms tests through Vitest; production code does not need bundling. The package includes `dist/**/*.js` so imports from nested modules work. Inspect `npm pack --dry-run --json --ignore-scripts` after changing the source layout.
- A Homebridge restart must preserve accessory identities. Move files freely, but treat plugin/platform names, UUID inputs, persisted context and external configuration as contracts.

## Tests and quality checks

Tests are TypeScript files beside the code they exercise, named `<module>.test.ts` or `<module>.<behavior>.test.ts`. Vitest imports source modules directly; a build is not needed to run one test. Shared fixtures use a `.test-support.ts` suffix beside the related module, such as `cloud/fake-cloud.test-support.ts` and `site/fake-scheduler.test-support.ts`. A test should exercise the seam that owns the behavior: client tests use a local fake HTTP server, coordination tests use a fake gateway and scheduler, and presentation tests use Homebridge/HAP objects. Fake responses and identities are synthetic; no real credentials or panel identifiers belong in the repository.

The production TypeScript configuration excludes tests and their helpers from `dist/`. Keep test discovery limited to `*.test.ts` in `vitest.config.ts`. Use Vitest's test lifecycle for cleanup, and preserve file isolation for tests that replace process-wide transport functions.

Use these commands in every plugin, with scripts adapted to its runtime:

```sh
npm ci
npm run format         # Apply Biome formatting
npm run test           # Run colocated Vitest tests
npm run check          # Biome, runtime typecheck, build and tests
npm pack --dry-run --json --ignore-scripts
```

`biome.json` is the single formatter and linter configuration. Biome checks TypeScript, JavaScript, JSON and CSS here; `tsc --noEmit` checks production types. Zod validates untrusted configuration and vendor response shapes; translate its errors into the plugin's fixed, safe error categories rather than logging raw input. Pin tool versions and commit the lockfile. CI should run the same checks as local development. This repository's ARMv7 runtime job runs `npm run check:runtime` because Biome has no ARMv7 executable; x64 CI runs the full Biome check.

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
3. Keep the entrypoints thin and separate vendor-specific code from Homebridge code. Use Zod at untrusted input edges and preserve safe, stable error categories.
4. Put TypeScript tests beside their owning module and fixtures beside the area that uses them. Align scripts and CI on Biome, `tsc`, Vitest and a production build. Use a runtime-only check on architectures for which Biome publishes no binary.
5. After moving files, update relative imports, test imports, documentation and package file globs. Verify `npm run check` and inspect the npm tarball before publishing.

For this plugin's protocol decisions and runtime behavior, see [Architecture](ARCHITECTURE.md). Those details are specific to Atlas/RISCO Cloud and are not a template for other devices.
