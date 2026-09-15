# Validation

## Automated coverage

`npm run check` runs formatting, lint, strict typechecking and behavioral tests on local fake services. CI covers Node 22.23.2, latest 22 and 24 on Linux x64, plus a pinned Linux ARMv7 Homebridge image under emulation.

| Boundary                                                      | Tests                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| Envelopes, three-stage login, expiry, PIN pause, retry bounds | `test/cloud.test.mjs`                                      |
| Partition and zone decoding                                   | `test/panel-model.test.mjs`                                |
| Polling, freshness, command exclusivity and confirmation      | `test/coordinator.test.mjs`                                |
| HAP Security System, zone sensors and cached identities       | `test/accessories.test.mjs`, `test/platform.test.mjs`      |
| Configuration and sanitized diagnostics                       | `test/configuration.test.mjs`, `test/diagnostics.test.mjs` |

## Actual-account evidence

- 2026-09-15: `POST /webapi/api/auth/login` with an empty body returned HTTP 200 and the envelope `{ validationErrors, errorText, errorTextCodeID, status: 500, response: null }`, matching the client's in-body status handling. No credentials were used.
- The web UI route was observed read-only on a live account; see [research](research/riscocloud-webui-api.md).

## Remaining evidence

1. Sign-in, site selection and PIN session against the owner's account, with a debug report confirming `armedState`, zone `status` and `zoneType` values.
2. A multi-day read-only soak on the owner's Homebridge (iHost, ARMv7, Node 22.23.2): restarts, freshness and recovery.
3. **Supervised command test** with the owner present: partial arm → disarm → full arm → disarm. Record confirmation timing, exit delay and any `armFailures`-style rejection when a zone is open.

Keep only current results here. Raw private observations stay outside the repository.
