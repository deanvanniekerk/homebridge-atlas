# Changelog

Release notes for `homebridge-atlas` live here. The release workflow publishes the section matching `package.json` to GitHub, so the npm package, tag and GitHub release all use the same version and notes.

## [0.1.0-alpha.0] - 2026-09-15

### Added

- RISCO Cloud mobile API client with three-stage sign-in, bounded retries and PIN-lockout protection.
- One Security System per partition and one motion or contact sensor per zone.
- Optional arming and disarming, off by default, with confirmation polling and no command replay.
- Sanitized debug diagnostics and a read-only `npm run diagnose` account check.
