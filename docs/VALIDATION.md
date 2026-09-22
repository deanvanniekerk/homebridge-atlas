# Validation

## Automated coverage

`npm run check` runs Biome formatting and lint checks, strict runtime TypeScript checks, a production build, and colocated Vitest tests on local fake services. CI runs the full check on Node 22.23.2, latest 22 and 24 on Linux x64. The pinned Linux ARMv7 Homebridge image runs typechecking, the build, and tests under emulation; Biome does not publish an ARMv7 binary.

| Boundary                                                      | Tests                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Envelopes, three-stage login, expiry, PIN pause, retry bounds | `src/cloud/cloud-client.test.ts`                                                      |
| Partition and zone decoding                                   | `src/site/panel-model.test.ts`                                                        |
| Polling, push, freshness, command exclusivity and confirmation | `src/site/coordinator*.test.ts`                                                       |
| HAP Security System, zone sensors and cached identities       | `src/homebridge/accessories.test.ts`, `src/homebridge/platform.test.ts`              |
| Configuration and sanitized diagnostics                       | `src/configuration.test.ts`, `src/site/diagnostics.test.ts`                           |

## Actual-account evidence

- 2026-09-15: `POST /webapi/api/auth/login` with an empty body returned HTTP 200 and the envelope `{ validationErrors, errorText, errorTextCodeID, status: 500, response: null }`, matching the client's in-body status handling. No credentials were used.
- 2026-09-15, `0.1.0-alpha.0` on the owner's iHost (ARMv7, Node 22.23.2, Homebridge 2.4.0), child bridge, control disabled, debug on:
  - Sign-in, single-site selection and PIN session succeeded on first start; state `source: panel`; no warnings.
  - One partition: `armedState` 1 (disarmed), `alarmState` 0, `exitDelayTO` 0, matching the Atlas web UI.
  - 26 zones decoded with no rejected records: `status` 0 ×23, 1 ×1, 2 ×2, consistent with the web UI's bypassed and open zones. `zoneType` was 256 for every zone, so it cannot distinguish motion from contact; name-based defaults remain.
  - Additional fields present: zone `trouble`, `part`, `partAssocMask`; partition `readyState`, `groups`, `lastArmFailReasons`; status `systemReady`, `armNotAllowed`, `disarmNotAllowed`, `acLost`, `batteryLow`, `trouble`; state `isOnline`, `lastStatusUpdate`. Their value semantics are not yet decoded.
  - 27 accessories registered (1 Security System, 16 motion, 10 contact sensors).
- 2026-09-15: `GET /webapi/api/wuws/site/0/ControlPanel/sse/connect` without credentials returned `401 Unauthorized` with `WWW-Authenticate: Bearer` and a plain-text body, confirming the push endpoint exists.
- 2026-09-15, `0.1.0-alpha.2` push on the owner's account:
  - The stream connected 2 s after start and delivered a `runtimeUpdate` immediately after opening; `IsOffline` was false and `lastStatusUpdate` was ISO UTC.
  - Opening and closing the front door produced two further `runtimeUpdate` events. Both refreshes read the cloud cache with no panel escalation; push-to-state latency was 535 ms.
  - The stream then failed as a connection error 120 s after the last update (not the client's idle timeout). The plugin reconnected within a second, but the shorter polling freshness window made state briefly stale; `0.1.0-alpha.3` keeps state fresh for one polling window after a drop.
- 2026-09-15, `0.1.0-alpha.4` on the owner's iHost (control disabled, push connected):
  - Only the zone the web UI showed as faulted reports `StatusFault` in HomeKit (1 of 20 visible zone sensors); the Security System reports no fault while `isOnline` is true, including when state comes from the cloud cache.
  - The diagnostic report shows `offline: false`, `online: true`, one zone fault, and partition `ready: false` with a door open.
  - Arming refusal while not ready was then verified live in the supervised test below.
- 2026-09-15, supervised command test on `0.1.0-alpha.4` with the owner present (monitored system, manual disarm ready), `enableControl` switched on, commands sent through Homebridge's accessory API:
  - **Readiness evidence:** `readyState` was 0 while a door was open and 2 once every zone was closed.
  - **Not-ready refusal:** with the Lounge Door open, a Home arm was refused by the plugin ("Arming refused: the panel is not ready"); the target reverted to Disarm and the owner confirmed the panel stayed disarmed.
  - **Partial arm:** with all zones closed, Home (stay) arm was accepted in 4.9 s and confirmed by panel state in 6.1 s; the owner confirmed the app showed partially armed. No fault or warning was logged.
  - **Disarm:** accepted in 3.4 s and confirmed in 4.6 s.
  - **Full (away) arm:** not tested; the owner chose to stop before arming with interior PIRs live.
- 2026-09-15, Homebridge verification rehearsal: the packed `0.1.0-alpha.6` tarball was installed with Homebridge 2.4.0 in a clean directory and started with no platform, only `platform`, minimal required and full generated configurations, modelled on the `homebridge/plugins` automated checks. Homebridge started in every case without crashes. The platform-only case logged "Atlas is not configured" and made no requests, and a synthetic `example.invalid` account paused on invalid credentials. Each run exited on SIGTERM in about 0.3 s with code 0, and a restart on the same port had no conflict. The built code matched none of the checker's code-safety patterns.
- The web UI route was observed read-only on a live account; see [research](research/riscocloud-webui-api.md).

## Remaining evidence

1. Owner comparison of Apple Home zone states with the Atlas app, including an open door and a bypassed zone.
2. Push reconnect behaviour over a multi-hour period (connection lengths and silence before drops) and arming/alarm pushes.
3. Readiness while all zones are closed (expected `readyState` 1) and an offline panel (`isOnline` false or pushed `IsOffline` true); neither has been observed yet.
4. A multi-day read-only soak on the owner's Homebridge (iHost, ARMv7, Node 22.23.2): restarts, freshness and recovery.
5. **Full (away) arm on the real panel:** exit-delay reporting, confirmation timing and alarm-free disarm. Partial arm, disarm and not-ready refusal are verified.

Keep only current results here. Raw private observations stay outside the repository.
