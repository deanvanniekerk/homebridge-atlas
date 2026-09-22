import { isRecord } from './cloud/cloud-error.js';

export type SensorKind = 'motion' | 'contact';
export type ZoneOverride = SensorKind | 'hidden';

export interface AtlasConfig {
  readonly name: string;
  readonly username: string;
  readonly password: string;
  readonly pin: string;
  readonly siteId: number | undefined;
  readonly pollInterval: number;
  /** `push` listens for RISCO Cloud change notifications and polls only as a safety net. */
  readonly updates: 'push' | 'poll';
  readonly debug: boolean;
  readonly enableControl: boolean;
  readonly partialArmMode: 'stay' | 'night';
  readonly includeZones: boolean;
  readonly zones: ReadonlyMap<number, ZoneOverride>;
}

type Field =
  | 'configuration'
  | 'name'
  | 'username'
  | 'password'
  | 'pin'
  | 'siteId'
  | 'pollInterval'
  | 'updates'
  | 'debug'
  | 'enableControl'
  | 'partialArmMode'
  | 'includeZones'
  | 'zones';
const messages: Record<Field, string> = {
  configuration: 'Configuration must be an object.',
  name: 'Name must contain 1–64 characters without leading/trailing whitespace or line breaks.',
  username: 'Enter an Atlas / RISCO username with 1–320 characters and no surrounding whitespace.',
  password: 'Enter a nonblank Atlas / RISCO password of at most 4096 characters.',
  pin: 'Enter the panel user code (PIN) as 4–8 digits.',
  siteId: 'Site ID must be a whole number when set.',
  pollInterval: 'Poll interval must be a whole number from 10 to 300 seconds.',
  updates: 'Updates must be "push" or "poll".',
  debug: 'Debug must be true or false.',
  enableControl: 'Enable arming and disarming must be true or false.',
  partialArmMode: 'Partial arm mode must be "stay" or "night".',
  includeZones: 'Include zones must be true or false.',
  zones:
    'Zone overrides must be a list of up to 256 unique zone IDs, each with type motion, contact or hidden.',
};
export class ConfigurationError extends Error {
  constructor(readonly field: Field) {
    super(messages[field]);
    this.name = 'ConfigurationError';
  }
}

function cleanText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    Array.from(value).length <= maximum &&
    /^\S(?:[^\r\n]*\S)?$/.test(value)
  );
}

function optionalBoolean(value: unknown, fallback: boolean, field: Field): boolean {
  const result: unknown = value === undefined ? fallback : value;
  if (typeof result !== 'boolean') throw new ConfigurationError(field);
  return result;
}

function zoneOverrides(value: unknown): ReadonlyMap<number, ZoneOverride> {
  const items: unknown = value === undefined ? [] : value;
  if (!Array.isArray(items) || items.length > 256) throw new ConfigurationError('zones');
  const zones = new Map<number, ZoneOverride>();
  for (const item of items) {
    if (
      !isRecord(item) ||
      !Number.isSafeInteger(item.id) ||
      (item.id as number) < 0 ||
      zones.has(item.id as number) ||
      (item.type !== 'motion' && item.type !== 'contact' && item.type !== 'hidden') ||
      // The settings page records the zone name for readability; it is not used for identity.
      (item.name !== undefined &&
        (typeof item.name !== 'string' || Array.from(item.name).length > 64))
    )
      throw new ConfigurationError('zones');
    zones.set(item.id as number, item.type);
  }
  return zones;
}

/** Reject before constructing a cloud client; never include rejected values or unknown keys in errors. */
export function parseConfig(input: unknown): AtlasConfig {
  if (!isRecord(input)) throw new ConfigurationError('configuration');
  const name: unknown = input.name === undefined ? 'Atlas' : input.name;
  if (!cleanText(name, 64)) throw new ConfigurationError('name');
  if (!cleanText(input.username, 320)) throw new ConfigurationError('username');
  if (
    typeof input.password !== 'string' ||
    Array.from(input.password).length > 4096 ||
    !/\S/.test(input.password)
  )
    throw new ConfigurationError('password');
  if (typeof input.pin !== 'string' || !/^\d{4,8}$/.test(input.pin))
    throw new ConfigurationError('pin');
  if (
    input.siteId !== undefined &&
    (!Number.isSafeInteger(input.siteId) || (input.siteId as number) < 0)
  )
    throw new ConfigurationError('siteId');
  const pollInterval: unknown = input.pollInterval === undefined ? 30 : input.pollInterval;
  if (
    typeof pollInterval !== 'number' ||
    !Number.isInteger(pollInterval) ||
    pollInterval < 10 ||
    pollInterval > 300
  )
    throw new ConfigurationError('pollInterval');
  const updates: unknown = input.updates === undefined ? 'push' : input.updates;
  if (updates !== 'push' && updates !== 'poll') throw new ConfigurationError('updates');
  const partialArmMode: unknown =
    input.partialArmMode === undefined ? 'stay' : input.partialArmMode;
  if (partialArmMode !== 'stay' && partialArmMode !== 'night')
    throw new ConfigurationError('partialArmMode');
  return Object.freeze({
    name,
    username: input.username,
    password: input.password,
    pin: input.pin,
    siteId: input.siteId as number | undefined,
    pollInterval,
    updates,
    debug: optionalBoolean(input.debug, false, 'debug'),
    enableControl: optionalBoolean(input.enableControl, false, 'enableControl'),
    partialArmMode,
    includeZones: optionalBoolean(input.includeZones, true, 'includeZones'),
    zones: zoneOverrides(input.zones),
  });
}

/** Default sensor kind from the installer's zone name; overridable per zone. */
export function sensorKindFor(zoneName: string): SensorKind {
  return /pir|motion|beam|curtain|detector/i.test(zoneName) ? 'motion' : 'contact';
}
