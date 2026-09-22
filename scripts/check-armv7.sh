#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo 'Commit or stash changes first: this check tests the committed source snapshot.' >&2
  exit 1
fi
case "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" in
  unix://*) ;;
  *) echo 'Use a local Unix-socket Docker context, not an iHost or remote Docker host.' >&2; exit 1 ;;
esac

scratch=$(mktemp -d)
trap 'node -e '\''require("node:fs").rmSync(process.argv[1], {recursive: true, force: true})'\'' "$scratch"' EXIT
git -C "$root" archive HEAD | tar -x -C "$scratch"
image='homebridge/homebridge@sha256:547c1429345a63537690198f20d8e48417ff0e0b9d452d10764a312c621e6cea'
docker run --rm --platform linux/arm/v7 --entrypoint /bin/sh \
  --mount "type=bind,source=$scratch,target=/source,readonly" "$image" -c '
    set -eu
    cp -R /source /tmp/atlas-check
    cd /tmp/atlas-check
    node -e '\''if (process.arch !== "arm" || Number(process.config.variables.arm_version) !== 7) process.exit(1)'\''
    npm ci --no-audit --no-fund
    # Biome does not publish a Linux ARMv7 binary; x64 CI runs its checks.
    npm run check:runtime
  '
