# Installation

## Prepare

1. Download a Homebridge backup using Settings → Backup & Restore. Protect it: it contains credentials and pairing data.
2. Do not run another RISCO integration against the same account at the same time; competing sessions can invalidate each other.

## Install a test build

Until a release is published, build a tarball from the intended commit on a development machine:

```sh
npm ci
npm run check
npm pack
```

Transfer the `.tgz` to the Homebridge host, verify its SHA-256, and install it in the directory where the host manages plugins. In the official Docker image this is normally `/var/lib/homebridge`:

```sh
cd /var/lib/homebridge
sha256sum homebridge-atlas-0.1.0-alpha.0.tgz
npm install --omit=dev --ignore-scripts --no-audit --no-fund ./homebridge-atlas-0.1.0-alpha.0.tgz
```

npm fetches the one runtime dependency (`@homebridge/plugin-ui-utils`); nothing is compiled on the host.

## Configure and pair

1. Open the plugin **Settings**, enter the Atlas app credentials and panel user code, click **Load detectors** and choose which detectors to show and their types. Leave arming and disarming off for the first run and turn on debug diagnostics. See [configuration](CONFIGURATION.md).
2. Enable a dedicated child bridge for the plugin and restart it.
3. Check the child bridge log for `Diagnostic report:` and confirm the partition and zone states match the Atlas app.
4. In Apple Home, add the child bridge using its QR code and assign rooms.
5. Only after a soak period, enable control and follow the supervised command test in [validation](VALIDATION.md).

## Upgrade, remove or roll back

Install the newer tarball the same way and restart only this child bridge. Never clear all Homebridge accessory caches to resolve one plugin's issue.

To remove, disable the plugin, remove its child bridge from Apple Home, then uninstall `homebridge-atlas` in Homebridge UI. Removing accessories deletes their Home automations.
