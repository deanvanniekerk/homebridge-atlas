import { type ClientOptions, RiscoClient } from '../cloud/cloud-client.js';
import { CloudError, isRecord } from '../cloud/cloud-error.js';
import { type SensorKind, sensorKindFor } from '../configuration.js';
import { decodePanelState, type ZoneCondition } from './panel-model.js';
import { systemScheduler } from './scheduler.js';

export interface ZoneChoice {
  readonly id: number;
  readonly name: string;
  readonly suggested: SensorKind;
  readonly condition: ZoneCondition | 'unknown';
  /** Vendor trouble flag for the zone. */
  readonly fault: boolean;
}

export type ZoneDiscovery =
  | { readonly kind: 'site-required'; readonly sites: readonly { id: number; name: string }[] }
  | {
      readonly kind: 'zones';
      readonly siteId: number;
      readonly partitions: number;
      readonly zones: readonly ZoneChoice[];
    };

function credentialsFrom(input: unknown) {
  if (!isRecord(input)) throw new CloudError('invalid-request');
  const siteId: unknown = input.siteId === null || input.siteId === '' ? undefined : input.siteId;
  return {
    username: typeof input.username === 'string' ? input.username.trim() : '',
    password: typeof input.password === 'string' ? input.password : '',
    pin: typeof input.pin === 'string' ? input.pin.trim() : '',
    ...(siteId === undefined ? {} : { siteId: Number(siteId) }),
  };
}

/**
 * Settings-page zone discovery: one read-only sign-in with the credentials being edited. Never
 * arms, disarms or bypasses, and never stores credentials outside the Homebridge config.
 */
export async function discoverZones(
  input: unknown,
  options: ClientOptions = {},
): Promise<ZoneDiscovery> {
  const credentials = credentialsFrom(input);
  const client = new RiscoClient(credentials, options);
  try {
    const result = await client.state();
    const panel = decodePanelState(result.value, {
      siteId: result.siteId,
      fromControlPanel: result.fromControlPanel,
      observedAtMs: systemScheduler.now(),
    });
    return {
      kind: 'zones',
      siteId: panel.siteId,
      partitions: panel.partitions.length,
      zones: panel.zones.map((zone) => ({
        id: zone.id,
        name: zone.name,
        suggested: sensorKindFor(zone.name),
        condition: zone.condition.available ? zone.condition.value : 'unknown',
        fault: zone.trouble.available && zone.trouble.value,
      })),
    };
  } catch (error) {
    if (!(error instanceof CloudError) || error.category !== 'site-selection') throw error;
    // The paused client cannot be reused; list sites without opening a panel session.
    const { username, password, pin } = credentials;
    const lister = new RiscoClient({ username, password, pin }, options);
    try {
      const sites = await lister.sites();
      if (sites.length === 0) throw error;
      return { kind: 'site-required', sites: sites.map(({ id, name }) => ({ id, name })) };
    } finally {
      lister.close();
    }
  } finally {
    client.close();
  }
}
