# Contributing

Bug fixes, documentation improvements and evidence-backed protocol corrections are welcome. Open an issue before a substantial behavior change so the intended scope is clear.

## Develop locally

Use Node from `.node-version` and npm 10.9.8:

```sh
npm ci
npm run check
```

`npm run check` runs Biome formatting and lint checks, strict runtime TypeScript checks, a production build, and the Vitest suite. `npm run format` applies Biome formatting; `npx biome check --write .` also organizes imports and applies safe lint fixes. Tests use local fake cloud servers and synthetic credentials; never point them at a real account or Homebridge installation.

For a focused change, run `npx vitest run src/<area>/<module>.test.ts`. Keep individual cases below 1,000 ms. Put tests beside the code they exercise; shared fake cloud and scheduler helpers live beside their related modules with a `.test-support.ts` suffix.

`npm run diagnose` is an owner-run, read-only check against your own account. It prompts for credentials with hidden input, never sends arm, disarm or bypass requests, and prints only structure, counts and enumerated values. Do not paste its output into issues if you have edited it to include names.

## Design and tests

Keep Homebridge presentation separate from transport, panel decoding and site scheduling. See [architecture](docs/ARCHITECTURE.md) and the [project structure guide](docs/PROJECT_STRUCTURE.md). Preserve bounded retries, cancellation, PIN-lockout protection, fresh command validation and no command replay. Transport acknowledgment does not establish that the panel armed or disarmed.

Add a regression at the boundary that owns the behavior. Prefer the real client/HAP code against local fakes over mocks that only assert their own calls. Keep fixtures small, sanitized and labeled as observed or synthetic.

Keep runtime dependencies minimal. This plugin uses `@homebridge/plugin-ui-utils` for the settings page and Zod for input and vendor schema validation. Do not copy another integration's implementation, tests or assets; public integrations may inform the wire contract only. Contributions are licensed under the repository's MIT license.

## Pull requests

Explain the problem, resulting behavior, tests and any support limits. Keep changes focused. Update current documentation rather than appending a diary.

Do not include credentials, PINs, site IDs, zone names, raw payloads or other real account identifiers.
