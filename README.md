# homebridge-atlas

A Homebridge plugin for **Atlas Home Security** (RISCO Cloud) alarm systems.

> **Status: research / pre-alpha.** Nothing is installable yet. The API has been mapped and state decoders exist, but there is no Homebridge platform yet.

## Goals

- Expose detector (zone) state in HomeKit as motion and contact sensors.
- Arm, partially arm and disarm partitions from HomeKit as a Security System.

## Documentation

- [Feasibility and plan](docs/FEASIBILITY.md)
- [RISCO Cloud web UI API reference](docs/research/riscocloud-webui-api.md)

## Development

```bash
npm install
npm run check
```

Tests use `node:test` against the compiled `dist/` output, with synthetic fixtures only. Never commit credentials, PINs, site ids or raw responses from a real account.

## License

MIT
