# homebridge-atlas

A Homebridge plugin for **Atlas Home Security** and other RISCO Cloud alarm systems: partition arming, detector state, faults and push updates in Apple Home.

Stable release 1.0.2. Validated on one owner's panel through Homebridge 2.4.0 on an ARMv7 iHost. There, detector states, zone faults and push updates matched the Atlas app. A supervised test armed Home (partial), disarmed, and refused arming while a door was open. Full (Away) arming on real hardware is still pending. See [validation](docs/VALIDATION.md) and the [changelog](CHANGELOG.md).

## What it does

- **Security System** per partition: Disarmed, Home (or Night) for partial arm, Away for full arm, and Alarm Triggered.
- **Motion or contact sensor** per detector. Bypassed detectors are shown as inactive, and a detector's trouble flag is shown as a fault.
- **Push updates** from RISCO Cloud, with polling as a fallback.
- **Settings page** that signs in, loads your detectors and lets you choose which appear in Apple Home and their sensor type.
- **Optional arming and disarming**, off by default. Arming is refused while the panel reports it is not ready, and commands are refused while the panel is offline.

It uses the RISCO Cloud service that RISCO's apps use, with the email, password and panel user code you use in the Atlas app.

## Settings

The settings page loads your detectors, lets you choose which ones appear in Apple Home and configures arming, updates and diagnostics.

<table>
  <tr>
    <td valign="top"><img src="https://github.com/user-attachments/assets/fcb80d52-3bff-4881-a964-6341b3cb9d78" alt="Atlas account and detector settings" /></td>
    <td valign="top"><img src="https://github.com/user-attachments/assets/26d8b9ab-8b6b-4971-95d3-c7711a8988ef" alt="Atlas arming, update and diagnostic options" /></td>
  </tr>
</table>

## Homebridge setup

Use Homebridge 2.4 or later with Node 22 or 24.

1. In Homebridge, open **Plugins**, search for `homebridge-atlas` and install it.
2. Open the plugin **Settings** and enter your Atlas email, password and panel user code.
3. Click **Load detectors**, choose which detectors to show and their types, then click **Save**.
4. Run the plugin as its own child bridge, restart it and add the bridge in Apple Home.

Leave **Allow arming and disarming** off until you have compared Apple Home with the Atlas app. A rejected panel user code pauses the plugin until restart, so the panel keypad cannot be locked out by repeated attempts.

See [installation](docs/INSTALLATION.md) and [configuration](docs/CONFIGURATION.md). For intermittent problems, turn on **Debug diagnostics**, restart the child bridge and look for `Diagnostic report:` in the log. Reports contain no detector names or credentials.

## Documentation

- [Installation](docs/INSTALLATION.md)
- [Configuration](docs/CONFIGURATION.md)
- [Validation](docs/VALIDATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Release checklist](RELEASE_STEPS.md) and [releasing](docs/RELEASING.md)
- [Contributing](CONTRIBUTING.md)

## Development

```sh
npm ci
npm run check
npm pack
```

`npm run diagnose` is an optional, read-only account check for development. It prompts for credentials in a terminal. The plugin itself never requires a terminal.

Independent project, not affiliated with RISCO Group, Atlas Security, Apple or Homebridge.

## License

MIT
