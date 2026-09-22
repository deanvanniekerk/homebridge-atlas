import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const releaseVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(alpha|beta)\.(0|[1-9]\d*))?$/;

export function releaseNotes(
  version,
  changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
) {
  if (!releaseVersionPattern.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`, 'm');
  const match = heading.exec(changelog);
  if (!match) {
    throw new Error(`CHANGELOG.md must contain a dated "## [${version}]" section.`);
  }
  const start = match.index + match[0].length;
  const remainder = changelog.slice(start);
  const next = /^## /m.exec(remainder);
  const notes = remainder.slice(0, next?.index).trim();
  if (!notes || !/^### /m.test(notes) || /\b(?:TBD|TODO)\b/i.test(notes)) {
    throw new Error(`CHANGELOG.md release ${version} must contain finished, categorized notes.`);
  }
  return `${notes}\n`;
}

const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : undefined;
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  const version = process.argv[2];
  if (!version) throw new Error('Usage: node scripts/release-notes.mjs VERSION');
  process.stdout.write(releaseNotes(version));
}
