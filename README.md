# homebridge-atlas

A Homebridge plugin for **Atlas Home Security** (RISCO Cloud) alarm systems.

> **Status: pre-alpha, not yet validated against a real account.** The transport, panel model, coordinator and accessories are implemented and tested against a synthetic cloud. Arming and disarming are off by default.

## What it does

- One **Security System** per partition: Disarmed, Home (or Night) for partial arm, Away for full arm, and Alarm Triggered.
- One **motion or contact sensor** per zone (detector), with bypassed zones shown as inactive.
- Optional arming and disarming from Apple Home (`enableControl`).

It uses the RISCO Cloud mobile API that RISCO's apps use (the Atlas24 app is published under RISCO's package namespace), with the email, password and panel user code you use in the app.

## Configuration

```json
{
  "platform": "Atlas",
  "username": "you@example.com",
  "password": "…",
  "pin": "1234",
  "enableControl": false,
  "partialArmMode": "stay",
  "zones": [{ "id": 12, "type": "hidden" }]
}
```

See `config.schema.json` for all options.

## Documentation

- [Installation](docs/INSTALLATION.md)
- [Configuration](docs/CONFIGURATION.md)
- [Validation](docs/VALIDATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Releasing](docs/RELEASING.md)
- [Feasibility and plan](docs/FEASIBILITY.md)
- [RISCO Cloud web UI API (alternative route)](docs/research/riscocloud-webui-api.md)
- [Contributing](CONTRIBUTING.md)

## Check your account (read-only)

```sh
npm ci
npm run diagnose
```

This prompts for your credentials with hidden input, reads your panel state once and prints only structure and counts. It never arms, disarms or bypasses.

## License

MIT
