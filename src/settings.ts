import { readFileSync } from 'node:fs';
import { isRecord } from './cloud/cloud-error.js';

export const PLUGIN_NAME = 'homebridge-atlas';
export const PLATFORM_NAME = 'Atlas';

/** Read the installed package metadata. */
export function pluginVersion(): string {
  try {
    const metadata: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    return isRecord(metadata) && typeof metadata.version === 'string'
      ? metadata.version
      : 'unknown';
  } catch {
    return 'unknown';
  }
}
