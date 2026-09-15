# Installation

## Prepare

1. Download a Homebridge backup using Settings → Backup & Restore. Protect it: it contains credentials and pairing data.
2. Do not run another RISCO integration against the same account at the same time; competing sessions can invalidate each other.

## Install from npm

In Homebridge UI, open **Plugins**, search for `homebridge-atlas` and install it. While releases are prereleases, choose the `alpha` version. Alternatively, run `npm install homebridge-atlas@alpha` in the npm environment Homebridge uses. npm installs the one runtime dependency (`@homebridge/plugin-ui-utils`); the plugin runs no install scripts and compiles nothing on the host.

## Install a test build

To test an unreleased commit, build a tarball on a development machine:

```sh
npm ci
npm run check
npm pack
```

Transfer the `.tgz` to the Homebridge host, verify its SHA-256, and install it in the directory where the host manages plugins. In the official Docker image this is normally `/var/lib/homebridge`:

```sh
cd /var/lib/homebridge
sha256sum homebridge-atlas-X.Y.Z.tgz
npm install --omit=dev --ignore-scripts --no-audit --no-fund ./homebridge-atlas-X.Y.Z.tgz
```

## Configure and pair

1. Open the plugin **Settings**, enter the Atlas app credentials and panel user code, click **Load detectors** and choose which detectors to show and their types. Leave arming and disarming off for the first run and turn on debug diagnostics. See [configuration](CONFIGURATION.md).
2. Enable a dedicated child bridge for the plugin and restart it.
3. Check the child bridge log for `Diagnostic report:` and confirm the partition and zone states match the Atlas app.
4. In Apple Home, add the child bridge using its QR code and assign rooms.
5. Only after a soak period, enable control and follow the supervised command test in [validation](VALIDATION.md).

## Upgrade, remove or roll back

Install the newer tarball the same way and restart only this child bridge. Never clear all Homebridge accessory caches to resolve one plugin's issue.

To remove, disable the plugin, remove its child bridge from Apple Home, then uninstall `homebridge-atlas` in Homebridge UI. Removing accessories deletes their Home automations.
