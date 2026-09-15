# Architecture

The plugin has no runtime dependencies. Homebridge supplies HAP; TypeScript and test tools are development dependencies. The layering, deadlines and error model follow [homebridge-aqua-temp](https://github.com/deanvanniekerk/homebridge-aqua-temp); command safety follows [homebridge-centsys](https://github.com/deanvanniekerk/homebridge-centsys).

| Module                                                  | Responsibility                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `cloud-client.ts`, `cloud-http.ts`, `cloud-protocol.ts` | Validated envelopes, three-stage authentication, deadlines and bounded retry |
| `cloud-time.ts`, `scheduler.ts`, `cloud-error.ts`       | Budgets, cancellable timers and fixed, log-safe failure categories           |
| `panel-model.ts`                                        | Strict partition/zone decoding into available/unavailable readings           |
| `gateway.ts`                                            | Client lifecycle and translation to panel state                              |
| `coordinator.ts`                                        | Site polling, freshness, command exclusivity and confirmation                |
| `platform.ts`                                           | Homebridge lifecycle, zone selection and stable accessory identities         |
| `security-system.ts`, `zone-sensor.ts`                  | HAP Security System per partition; motion/contact sensor per zone            |
| `configuration.ts`, `diagnose.ts`                       | Runtime config validation; owner-run read-only API check                     |

## Transport

The vendor origin is `https://www.riscocloud.com`, the RISCO Cloud mobile API used by the Atlas24 and iRISCO apps. All calls are JSON `POST`s.

1. `/webapi/api/auth/login` with `{ userName, password }` → `response.accessToken`.
2. `/webapi/api/wuws/site/GetAll` (Bearer) → sites `[{ id, name }]`. The configured `siteId` is required when more than one site is visible.
3. `/webapi/api/wuws/site/{siteId}/Login` with `{ languageId: "en", pinCode }` → `response.sessionId`.
4. `/webapi/api/wuws/site/{siteId}/ControlPanel/GetState` with `{ fromControlPanel, sessionToken }` → `response.state.status.{ partitions, zones }`.
5. `/webapi/api/wuws/site/{siteId}/ControlPanel/PartArm` with `{ partitions: [{ id, armedState }], fromControlPanel: true, sessionToken }`; `armedState` 1 = disarm, 2 = partial, 3 = arm.

Replies are `{ status, errorText, result, response }`. Success requires `status` 200 and a zero or absent `result`. Status 401 means invalid credentials before a token exists and session expiry afterwards. Result 72 means the cloud timed out waiting for the panel; other non-zero results are vendor rejections. Vendor text is never surfaced.

Requests have a 15-second deadline, 64 KiB request and 1 MiB response limits, TLS verification and no redirects. Reads have a 45-second budget; a panel timeout falls back once to `fromControlPanel: false` (cloud-cached state, marked `source: "cloud"`), then at most two transient retries. Session expiry renews the whole login once. Login is shared across callers.

Invalid credentials, a rejected site selection and **any definite rejection of the PIN stage** pause traffic until restart: panels lock their keypad after repeated wrong codes, so the plugin never loops on a PIN. Transient failures back off from 5 seconds to 5 minutes with jitter and honor Retry-After. Repeated session invalidation enters a five-minute cooldown. Commands are never replayed; a dispatched failure is marked delivery-uncertain.

## Panel decoding

Partitions are keyed by `id`; `armedState` 1/2/3 maps to disarmed/partial/armed, `alarmState` 0/1 to alarm, `exitDelayTO` to seconds remaining. Zones are keyed by `zoneID`; `status` 0/1/2 maps to normal/triggered/bypassed and `zoneType` is kept raw. Unknown values stay unavailable rather than guessed. Records with missing or duplicate identity are dropped and counted. These mappings come from public integrations and synthetic tests; `npm run diagnose` checks them against a real account.

## Scheduling and commands

One site loop polls from completion (default 30 seconds, 10–300). State expires after three intervals; getters then report communication failure. Credential, PIN and site failures report `auth-required`; protocol mismatches `protocol-error`. Subscribers receive the latest snapshot; the limit is eight.

A command requires fresh partition state and skips no-ops. Only a command in transport is exclusive (`busy`); an accepted command becomes a pending target that polls confirm every three seconds for up to two minutes. A newer command, such as a disarm during the exit delay, replaces the pending target. Confirmation only counts polls started after acceptance. An expired target reports `unconfirmed` until the next command. Shutdown never saves or replays commands.

## Homebridge presentation

Accessory identity is `homebridge-atlas:site:{siteId}:{partition|zone}:{id}`. Context holds that identity and the zone sensor type only. Cached accessories receive handlers before fresh data and report communication failure until then.

The Security System maps disarmed/partial/armed to DISARMED/STAY or NIGHT/AWAY, and an active alarm to ALARM_TRIGGERED. Target state shows the pending command, otherwise the reported state. With `enableControl` off (the default) the target is read-only and writes are refused. `StatusFault` is set while the state is cloud-cached.

Zones default to motion sensors when their name contains PIR, motion, beam, curtain or detector, otherwise contact sensors; config can override or hide a zone by ID. A bypassed zone is reported inactive and not triggered. A sensor-type change swaps the service in place, keeping identity. Hidden zones and other sites' accessories are removed after fresh state arrives; temporary omissions are kept. Getters never initiate network traffic.
