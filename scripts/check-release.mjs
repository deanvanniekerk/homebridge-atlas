import { readFileSync } from 'node:fs';
import { releaseNotes, releaseVersionPattern } from './release-notes.mjs';

const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const approved = process.env.ATLAS_RELEASE_APPROVED;
const version = releaseVersionPattern.exec(metadata.version);
if (!version) {
  throw new Error('Release version must be X.Y.Z, X.Y.Z-alpha.N or X.Y.Z-beta.N.');
}
if (approved !== metadata.version) {
  throw new Error(
    `Release approval must match package.json version ${metadata.version}. The approved_version input does not change the package version.`,
  );
}
const tag = version[5] ?? 'latest';
if (
  metadata.private ||
  metadata.publishConfig?.access !== 'public' ||
  metadata.publishConfig?.tag !== tag ||
  metadata.publishConfig?.registry !== 'https://registry.npmjs.org/'
) {
  throw new Error('Release metadata must select public npm access and the matching dist-tag.');
}
releaseNotes(metadata.version);
console.log(
  `Release guard passed for ${metadata.name}@${metadata.version} (${tag}); matching changelog notes found.`,
);
