import { z } from 'zod';
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

const boundedText = (maximum: number) =>
  z
    .string()
    .refine((value) => Array.from(value).length <= maximum && /^\S(?:[^\r\n]*\S)?$/.test(value));
const identifier = z.number().int().nonnegative().refine(Number.isSafeInteger);
const zoneSchema = z.object({
  id: identifier,
  type: z.enum(['motion', 'contact', 'hidden']),
  // Stored only for readability in the settings page; never used as identity.
  name: z
    .string()
    .refine((value) => Array.from(value).length <= 64)
    .optional(),
});
const configSchema = z.object({
  name: boundedText(64).default('Atlas'),
  username: boundedText(320),
  password: z.string().refine((value) => Array.from(value).length <= 4096 && /\S/.test(value)),
  pin: z.string().regex(/^\d{4,8}$/),
  siteId: identifier.optional(),
  pollInterval: z.number().int().min(10).max(300).default(30),
  updates: z.enum(['push', 'poll']).default('push'),
  debug: z.boolean().default(false),
  enableControl: z.boolean().default(false),
  partialArmMode: z.enum(['stay', 'night']).default('stay'),
  includeZones: z.boolean().default(true),
  zones: z
    .array(zoneSchema)
    .max(256)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length)
    .default([]),
});

/** Reject before constructing a cloud client; never include rejected values or unknown keys in errors. */
export function parseConfig(input: unknown): AtlasConfig {
  if (!isRecord(input)) throw new ConfigurationError('configuration');
  const result = configSchema.safeParse(input);
  if (!result.success) {
    const key = result.error.issues[0]?.path[0];
    throw new ConfigurationError(
      typeof key === 'string' && Object.hasOwn(messages, key) ? (key as Field) : 'configuration',
    );
  }
  const config = result.data;
  return Object.freeze({
    name: config.name,
    username: config.username,
    password: config.password,
    pin: config.pin,
    siteId: config.siteId,
    pollInterval: config.pollInterval,
    updates: config.updates,
    debug: config.debug,
    enableControl: config.enableControl,
    partialArmMode: config.partialArmMode,
    includeZones: config.includeZones,
    zones: new Map<number, ZoneOverride>(config.zones.map(({ id, type }) => [id, type])),
  });
}

/** Default sensor kind from the installer's zone name; overridable per zone. */
export function sensorKindFor(zoneName: string): SensorKind {
  return /pir|motion|beam|curtain|detector/i.test(zoneName) ? 'motion' : 'contact';
}
