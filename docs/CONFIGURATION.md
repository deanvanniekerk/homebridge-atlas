# Configuration

Use Homebridge UI → Plugins → Atlas → Plugin Config. The platform alias is `Atlas`.

```json
{
  "platform": "Atlas",
  "name": "Atlas",
  "username": "you@example.com",
  "password": "your-password",
  "pin": "1234",
  "pollInterval": 30,
  "debug": false,
  "enableControl": false,
  "partialArmMode": "stay",
  "includeZones": true,
  "zones": []
}
```

| Option                 | Default  | Meaning                                                                            |
| ---------------------- | -------- | ---------------------------------------------------------------------------------- |
| `name`                 | Atlas    | Security System display name; 1–64 characters                                      |
| `username`, `password` | Required | The credentials you use in the Atlas app, stored in local Homebridge configuration |
| `pin`                  | Required | Panel user code (4–8 digits) used to open the RISCO Cloud panel session            |
| `siteId`               | —        | Only needed when the account sees more than one site                               |
| `pollInterval`         | `30`     | Seconds between completed polls; whole number 10–300                               |
| `debug`                | `false`  | Emit sanitized diagnostic reports                                                  |
| `enableControl`        | `false`  | Allow arming and disarming from Apple Home                                         |
| `partialArmMode`       | `stay`   | Show partial arm as Home (`stay`) or Night (`night`)                               |
| `includeZones`         | `true`   | Add a sensor per zone                                                              |
| `zones`                | `[]`     | Per-zone overrides: `{ "id": 12, "type": "motion" \| "contact" \| "hidden" }`      |

## Zones

Zone names containing PIR, motion, beam, curtain or detector become motion sensors; all others become contact sensors. Override a zone by its ID, or hide it. A type change keeps the accessory identity; hiding a zone removes its accessory after the next fresh poll. A bypassed zone is shown inactive.

## Safety

A rejected PIN pauses the plugin until restart rather than retrying, so the panel keypad cannot be locked out by repeated attempts. Arming and disarming stay off until `enableControl` is set; with it off, Apple Home shows the Security System read-only.

## Diagnostics

Normal logs report failures and recovery once per change. Enable `debug`, restart the child bridge and find `Diagnostic report:` in its log. Reports are emitted at most once every five minutes and include runtime versions, partition states, zone condition counts and the vendor field names and enumerated values seen. When a reply cannot be decoded, the report includes its structure without values.

Reports exclude zone names, credentials, tokens, PINs and site IDs. Copy only the report when requesting support.
