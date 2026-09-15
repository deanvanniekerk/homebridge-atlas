# Feasibility

Investigated 2026-09-15. This is a research assessment, not a claim of compatibility.

## Assessment

Both goals look feasible through RISCO Cloud:

1. **Detector state.** Confirmed from a live, read-only session. `POST /Detectors/Get` returns every zone with its open/closed state, bypass and fault flags, plus each partition's arm state. `POST /Security/GetCPState` is a lightweight 5 s delta poll that also reports alarm and offline status.
2. **Arm and disarm.** The route is identified but has **not** been exercised. `POST /Security/ArmDisarm` with `type=0:armed|0:partially|0:disarmed` is what the web UI sends, and it matches independent prior art ([homebridge-risco-alarm](https://github.com/szlaskidaniel/homebridge-risco-alarm), [homebridge-risco-platform](https://github.com/gawindx/homebridge-risco-platform)).

The full request and response shapes are in [research/riscocloud-webui-api.md](research/riscocloud-webui-api.md).

## Evidence gathered

- A live session on `webui.riscocloud.com` for a single-partition system. Its zones covered the closed, open, bypassed and fault conditions.
- The network log for the main page: `Detectors/Get`, `Overview/Get`, `Cameras/Get`, `EventHistory/Get`, then `Security/GetCPState` repeating every 5 s.
- Response bodies for `Detectors/Get`, `Overview/Get` and `GetCPState`. Committed fixtures are synthetic re-creations of these.
- Page state: partition radio group `SecSelect0` (partially / disarmed / armed), group radios `GrpSelectG0..2`, `g_IsVirtualPanel=false`, and the web UI's error-code translation table.
- Public scripts `jquery.more.js` and `jquery.main.js`: polling, command, PIN-check and error-handling logic.

## Open questions

1. **Site login form fields** on `webui.riscocloud.com`. Prior art used `SelectedSiteId` and `Pin` on the older `/ELAS/WebUI` host. Confirming this needs the owner to capture a sign-in with the browser dev tools open, or a one-off local script run with the owner's credentials.
2. **Session lifetime.** How long an idle cookie session lasts, and whether `userIsAlive=true` extends it.
3. **Mobile API.** Does the Atlas account work against `https://www.riscocloud.com/webapi/api/auth/login`, the API used by Home Assistant's pyrisco? If it does, it offers typed zone data, bearer tokens and server-sent events.
4. **Command semantics** on this panel: whether arming with open zones returns `armFailures`, how long the exit delay is, and whether a PIN is required every time (`IsUserCodeExpired`).
5. **Zone types.** The web UI does not expose them, so the accessory type (motion or contact) will come from configuration or a guess based on the name.

## Available routes

| Route                   | Transport                                       | Pros                                                                            | Cons                                                                                                         |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Web UI (verified reads) | Cookie session and form posts, JSON actions     | Proven against this account today; simple JSON for state                        | Legacy MVC app; two-stage session; localised strings; delta poll needs one session per client; no zone types |
| Mobile `webapi`         | Bearer token + site session token, JSON, SSE    | Typed partitions and zones, push updates, maintained prior art (Home Assistant) | Unverified for Atlas accounts                                                                                |
| Local panel (LAN)       | RISCO proprietary TCP protocol to the IP module | No cloud dependency                                                             | Needs panel access code and network access; cloud connection may conflict; out of scope for now              |

## Proposed Homebridge design

Follow the same layering as the CENTSYS and AquaTemp plugins:

- **Transport client**
  - Authenticates in two stages and holds the cookie jar in memory. Credentials (username, password, PIN) come from Homebridge config, as in AquaTemp; no custom UI is needed.
  - Uses an injectable `fetch`, deadlines, `redirect: "manual"` so login redirects can be checked, and capped bodies.
  - Re-authenticates once when `classifyError` reports a session outcome. It never replays a command.
- **Coordinator**
  - Takes an initial `Detectors/Get` snapshot, then polls `GetCPState` (configurable, default 10 s) and applies the deltas.
  - After a command it polls quickly until `ExitDelayTimeout` reaches zero.
  - Backs off exponentially on failure. Snapshots expire so HomeKit never shows stale state as current.
- **Accessories**
  - One `SecuritySystem` per partition:
    - Current state: `DISARMED`, `AWAY_ARM` for armed, `STAY_ARM` or `NIGHT_ARM` for partial (configurable), and `ALARM_TRIGGERED` when `OngoingAlarm` is set.
    - Target state maps to `ArmDisarm`.
    - `StatusFault` is set when the panel is offline.
  - One `MotionSensor` or `ContactSensor` per zone:
    - `StatusFault` reflects the trouble flag and `StatusTampered` is available for tamper zones.
    - `StatusActive=false` when a zone is bypassed.
    - Zones are included or excluded by id in config.

**Command safety** (matching CENTSYS):

- Control is off by default and must be turned on explicitly.
- One command runs at a time. A command is not sent while state is unknown.
- An arm that returns `armFailures` is reported as rejected. Zones are never bypassed automatically.
- Disarm is never retried when the outcome is uncertain.

## Route decision

The Atlas app is **Atlas24**, published under RISCO's own package namespace (`com.riscogroup.atlas`), and the owner signs in to it with the same credentials as the web UI. That it uses the same `webapi` as iRISCO is an inference until `npm run diagnose` succeeds. The plugin therefore uses the RISCO Cloud mobile API (`webapi`), whose typed partition and zone fields avoid the web UI's localized strings and delta polling. The web UI research is kept as the fallback route.

## Next implementation steps

1. ✅ Transport client, panel model, coordinator, platform and accessories against a synthetic cloud ([architecture](ARCHITECTURE.md)).
2. **Owner-run `npm run diagnose`** to confirm the envelope, `state.status` fields, `armedState`/zone `status` values and `zoneType` codes. Correct the model if any differ.
3. Install a packed build on the owner's Homebridge with `enableControl: false` and soak-test state and freshness.
4. **Owner-supervised command test:** partial arm → disarm → full arm → disarm, recording confirmation timing and exit delay in `docs/VALIDATION.md`.
5. ✅ Hybrid push updates over the server-sent events stream (`ControlPanel/sse/connect`) with polling fallback; latency and coverage validation pending.
6. Release preparation mirroring the sibling plugins: CHANGELOG, release workflow, ARMv7 lane and npm trusted publishing.
