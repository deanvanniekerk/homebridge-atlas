# RISCO Cloud web UI API

Investigated 2026-09-15 from a signed-in session on `https://webui.riscocloud.com`. This work was read-only: the only requests made were the ones the web UI makes on page load and during its idle polling. No arm, disarm, bypass or settings request was sent. Everything under "Commands" comes from reading the public scripts (`/Scripts/jquery.more.js`, `/Scripts/jquery.main.js`) and has **not** been exercised.

Atlas Home Security accounts use the RISCO Cloud web UI (page title "RISCO Cloud"). It is a server-rendered ASP.NET MVC app using jQuery 1.8. Pages call JSON "controller actions" with `POST` and no request body. Authentication is a server-side session held in HttpOnly cookies. There is no bearer token.

## Session model

Signing in takes two stages, and each stage can expire on its own.

| Stage | Page                                           | Submits (form-urlencoded)                                                                                            | Result                                                    |
| ----- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| User  | `GET /UserLogin` renders a form that posts `/` | `username`, `password`, `RememberMe=false`, `strRedirectToEventUID=`, `strRedirectToSiteId=`                         | Redirects to `/SiteLogin/Index`. Sets the session cookie. |
| Site  | `/SiteLogin/Index`                             | Site id and panel PIN. Prior art uses the field names `SelectedSiteId` and `Pin`; **not yet confirmed on this host** | Redirects to `/MainPage/MainPage`.                        |

- The user login form has no `__RequestVerificationToken`. Forms inside the signed-in app do carry one, but none of the endpoints below need it.
- `POST /SystemSettings/IsUserCodeExpired` returns `{ pinExpired }`. The UI asks for the PIN again before a command when this is `true` or missing.
- After a site session error the UI sends the browser to `/SiteLogin/SiteSessionExpired?reason=<code>`. After a user session error it goes to `/UserLogin/SessionEnd?errorNum=<code>`.
- Logout is `GET /UserLogin/Logout`.

## Envelope and error codes

Every JSON action returns `{ "error": <int>, ... }`. The web UI handles the codes like this (`HandleErrorCode`, `RefreshAll`):

| Code                            | Meaning (UI text or behaviour)                                 | Plugin outcome (`classifyError`) |
| ------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| 0                               | Success                                                        | `ok`                             |
| 17, 72                          | Timed out waiting for a pending panel task; polling ignores it | `pending`                        |
| 1, 2, 3, 4, 10, 22, 51, 55, 500 | Redirect to site session expired                               | `site-session-expired`           |
| 501                             | Login name changed; user session ended                         | `user-session-expired`           |
| 5001                            | User PIN changed; redirect to site login                       | `pin-changed`                    |
| 14                              | "PIN Code does not match"                                      | `pin-rejected`                   |
| 26                              | Server lost connection with the control system                 | `panel-unreachable`              |
| 28, 52                          | Control system rejected the request                            | `rejected`                       |
| 77                              | Not permitted by the account's functional profile              | `rejected`                       |

An HTTP failure is treated as error 500.

## Reads

### `POST /Security/GetCPState[?userIsAlive=true]`

This is the poll endpoint. The UI calls it every **5 s** for a physical panel, or every 30 s for a virtual panel (`g_IsVirtualPanel`). It adds `userIsAlive=true` after any user interaction, which appears to keep the session alive. It is a **delta** feed: `strResult`, `detectors`, `overview` and `eh` are `null` unless something has changed since the previous call in this session.

```json
{
  "error": 0,
  "strResult": null,
  "eh": null,
  "overview": null,
  "haSwitch": null,
  "detectors": null,
  "allGrpState": null,
  "IsOffline": false,
  "OfflineSince": "N/A",
  "ShowRearmButton": false,
  "OngoingAlarm": false,
  "MemoryAlarm": true,
  "HideDisarmOption": true,
  "unix_time": 1767225600.5,
  "PartArmString": "Partial ",
  "FullArmString": "Set ",
  "ExitDelayTimeout": [0],
  "PartArmFailures": null
}
```

- `strResult`, when present, is `"<summary><p0><p1>…:<groups>"`. Each partition character is `D` (disarmed), `P` (partial) or `A` (armed). Character `j ≥ 1` drives the radio group `SecSelect{j-1}`. The groups half is superseded by `allGrpState` when that is present.
- `detectors`, when present, has the same shape as `Detectors/Get` → `detectors`.
- `ExitDelayTimeout[i]` is the number of seconds of exit delay left for partition `i`.
- `OngoingAlarm` means an active alarm. `MemoryAlarm` means an alarm is held in memory (already over). `HideDisarmOption` and `ShowRearmButton` only control the alarm banner buttons.
- `IsOffline` and `OfflineSince` report whether the panel is connected to the cloud.
- `PartArmFailures[i]` is `null`, or `{ failures: [{ Reason: [...] }] }` explaining why arming partition `i` failed.

### `POST /Detectors/Get`

This returns the full zone list and each partition's arm icon. It is the best source for an initial snapshot.

```json
{
  "error": 0,
  "detectors": {
    "parts": [
      {
        "id": 0,
        "name": "Home",
        "armIcon": "/Content/images/ico-disarmed.png",
        "detectors": [
          {
            "id": 1,
            "bypassed": false,
            "filter": "triggered",
            "classAttrib": "",
            "data_icon": "detector2",
            "name": "Front Door",
            "strTimeval": ""
          }
        ]
      }
    ]
  }
}
```

| Field                  | Observed values                                                           | Meaning                                                     |
| ---------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `part.id`              | `0`; the UI treats `< 0` as "System"                                      | Partition id                                                |
| `part.armIcon`         | `ico-disarmed.png`; `ico-armed.png` and `ico-partial.png` are also served | Partition arm state                                         |
| `detector.id`          | Zone numbers, not contiguous                                              | Zone id, used by `Detectors/SetBypass?id=`                  |
| `detector.filter`      | `""`, `"triggered"`, `"bypassed"`                                         | Tab filter: `triggered` means open/violated                 |
| `detector.bypassed`    | boolean                                                                   | Zone bypassed (omitted)                                     |
| `detector.classAttrib` | `""`, `"disable"` (bypassed), `"error"`                                   | `error` shows a fault badge (Overview hint: "Zone Fault")   |
| `detector.data_icon`   | `detector`, `detector2` (triggered), `detector5` (bypassed)               | Icon only                                                   |
| `detector.strTimeval`  | `""` or a locale-formatted `dd/MM/yyyy h:mm tt`                           | Last activity or alarm time. Locale-dependent, do not parse |

Zone type (PIR, door contact, beam, tamper, keyswitch, panic) is **not** exposed. It can only be guessed from the zone name.

### `POST /Overview/Get`

This returns recent alarms, the list of bypassed zones and partition counts. The counts are **localised strings** such as `"1 Partition"`, so the plugin should not use them for state.

```json
{
  "error": 0,
  "overview": {
    "lastAlarms": [
      {
        "dateStr": "…",
        "timeStr": "…",
        "title": "Alarm - 'Home', 'Garden Beam'",
        "ViUID": "",
        "YTime": "2026-1-2 15:15:00"
      }
    ],
    "bypassed": [{ "dateStr": "…", "timeStr": "…", "title": "Kitchen PIR" }],
    "partInfo": {
      "armedStr": "0 Partitions ",
      "disarmedStr": "1 Partition",
      "partarmedStr": "0 Partitions "
    },
    "cameraSlides": [],
    "errorIconHint": "Zone Fault\n"
  }
}
```

### Other read actions seen

`/EventHistory/Get`, `/Cameras/Get`, `/SystemSettings/GetCountryStatesAndTimeZones`, `/SystemSettings/GetUserSettings` and `/SystemSettings/IsUserCodeExpired`.

## Commands (from the scripts; not exercised)

### `POST /Security/ArmDisarm`

This takes a form-urlencoded body: `type`, `passcode`, `bypassZoneId=-1`.

| UI control               | `type`                                             |
| ------------------------ | -------------------------------------------------- |
| Partition `i` radio      | `"{i}:armed"`, `"{i}:disarmed"`, `"{i}:partially"` |
| All partitions (header)  | `"armed"`, `"disarmed"`, `"partially"`             |
| Group arm                | `"armGroups"` + partition                          |
| Refresh after exit delay | `"Refresh"` with `passcode: "------"`              |

- `passcode` comes from the PIN popup, and is only needed when `IsUserCodeExpired` says so. Prior art sends `""` to arm and `"------"` to disarm.
- **Response:**
  - If `strResult` contains `:`, the new state is final. Update from `strResult`, then re-fetch Overview and Detectors.
  - If `strResult` is a number, it is the exit delay in seconds. The UI waits `n + 4` s and then sends `type: "Refresh"` to collect the final state.
  - If `armFailures` is not `null`, arming was refused. It lists zone reasons, and the UI offers to bypass and retry via `bypassZoneId`.
  - A non-zero `error` with no `:` in `strResult` means the command failed.

Other commands exist but are out of scope and must never be sent by the plugin: `/Detectors/SetBypass?id=`, `/EventHistory/AlarmDismiss`, `/Automation/HACommand`, and the `SystemSettings` user and PIN management actions.

## Alternative: RISCO Cloud mobile API

The iRISCO mobile app and Home Assistant's `risco` integration ([pyrisco](https://github.com/OnFreund/pyrisco)) use a JSON API at `https://www.riscocloud.com/webapi/api/` instead:

- `POST auth/login` `{userName, password}` → `accessToken`
- `POST wuws/site/GetAll` (Bearer) → sites
- `POST wuws/site/{siteId}/Login` `{languageId, pinCode}` → `sessionToken`
- `POST wuws/site/{siteId}/ControlPanel/GetState` `{sessionToken, fromControlPanel}` → partitions and zones with typed fields
- `POST wuws/site/{siteId}/ControlPanel/PartArm` `{partitions:[{id, armedState}], sessionToken}`, where `armedState` is 1 = disarm, 2 = partial, 3 = arm
- `GET wuws/site/{siteId}/ControlPanel/sse/connect` → server-sent events

This API has not been checked against an Atlas account. If the Atlas app is a RISCO white-label, it probably uses this API, which would give typed zone data and push updates. See [FEASIBILITY.md](../FEASIBILITY.md) for the recommendation.
