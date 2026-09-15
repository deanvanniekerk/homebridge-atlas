# Changelog

Release notes for `homebridge-atlas` live here. The release workflow publishes the section matching `package.json` to GitHub, so the npm package, tag and GitHub release all use the same version and notes.

## [0.1.0-alpha.4] - 2026-09-15

### Added

- Zone faults: a zone's trouble flag sets the sensor's fault status in Apple Home, and the settings page marks faulted detectors.
- Panel offline: when the panel is disconnected from RISCO Cloud, the security system and every zone show a fault, the log warns once, and commands are refused.
- Arming is refused with a log warning while the panel reports the partition is not ready to arm; disarming is never blocked.
- Partition readiness, panel online state and zone fault count in the diagnostic report.

### Fixed

- The security system no longer shows a fault just because state was read from the cloud's cache, which push updates do routinely.
- Refreshes around a push drop and reconnect read the cloud's cached state instead of asking the panel.

## [0.1.0-alpha.3] - 2026-09-15

### Fixed

- A dropped push connection no longer makes accessories briefly unavailable: state stays fresh for one polling window while the plugin refreshes and reconnects.

### Added

- Connection length and silence before a drop in the diagnostic report.

## [0.1.0-alpha.2] - 2026-09-15

### Added

- Push updates (default): listen to the RISCO Cloud event stream and refresh on change, reading the cloud's cached state and asking the panel only when the cache is older. Polling drops to a five-minute safety net while connected and resumes at the configured interval when the stream is unavailable.
- `updates` option (`push` or `poll`) in configuration and the settings page.
- Push connection, update latency and event counts in the diagnostic report.

## [0.1.0-alpha.1] - 2026-09-15

### Added

- Settings page that signs in, loads every detector and lets you choose which appear in Apple Home and whether each is a motion or contact sensor.
- Vendor result codes and read statistics in the log and diagnostic report.

### Fixed

- A live panel read that exceeds the request deadline now falls back to the cloud's cached state instead of backing off until the site goes stale.

## [0.1.0-alpha.0] - 2026-09-15

### Added

- RISCO Cloud mobile API client with three-stage sign-in, bounded retries and PIN-lockout protection.
- One Security System per partition and one motion or contact sensor per zone.
- Optional arming and disarming, off by default, with confirmation polling and no command replay.
- Sanitized debug diagnostics and a read-only `npm run diagnose` account check.
