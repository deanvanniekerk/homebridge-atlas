import { CloudError, isRecord } from './cloud-error.js';
import type { ArmTarget } from './cloud-protocol.js';
import { fieldNames } from './shape.js';

export type Reading<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false; readonly reason: 'missing' | 'invalid' | 'unrecognized' };

export type ArmState = ArmTarget;
export type ZoneCondition = 'normal' | 'triggered' | 'bypassed';

export interface PartitionState {
  readonly id: number;
  readonly arm: Reading<ArmState>;
  readonly alarm: Reading<boolean>;
  readonly exitDelaySeconds: Reading<number>;
}

export interface ZoneState {
  readonly id: number;
  readonly name: string;
  /** Raw vendor zone type code; its meaning is not yet verified. */
  readonly type: number | undefined;
  readonly condition: Reading<ZoneCondition>;
}

/** Vendor structure seen in the latest reply: field names and enumerated value counts only. */
export interface PanelEvidence {
  readonly stateKeys: readonly string[];
  readonly statusKeys: readonly string[];
  readonly partitionFields: readonly string[];
  readonly zoneFields: readonly string[];
  readonly armedStates: Readonly<Record<string, number>>;
  readonly alarmStates: Readonly<Record<string, number>>;
  readonly zoneStatuses: Readonly<Record<string, number>>;
  readonly zoneTypes: Readonly<Record<string, number>>;
  readonly zoneTroubles: Readonly<Record<string, number>>;
  readonly partitionReadyStates: Readonly<Record<string, number>>;
  readonly online: Readonly<Record<string, number>>;
}

export interface PanelState {
  readonly siteId: number;
  /** `cloud` means the control panel did not answer and the cloud served its cached state. */
  readonly source: 'panel' | 'cloud';
  readonly observedAtMs: number;
  readonly partitions: readonly PartitionState[];
  readonly zones: readonly ZoneState[];
  /** Records dropped because their identity was missing, invalid or duplicated. */
  readonly rejectedRecords: number;
  readonly evidence: PanelEvidence;
}

const maximumRecords = 1000;

const armStates = new Map<unknown, ArmState>([
  [1, 'disarmed'],
  [2, 'partial'],
  [3, 'armed'],
]);
const alarmStates = new Map<unknown, boolean>([
  [0, false],
  [1, true],
]);
const zoneConditions = new Map<unknown, ZoneCondition>([
  [0, 'normal'],
  [1, 'triggered'],
  [2, 'bypassed'],
]);

function identifier(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function mapped<T>(value: unknown, values: Map<unknown, T>): Reading<T> {
  if (value === undefined || value === null) return { available: false, reason: 'missing' };
  if (!Number.isInteger(value)) return { available: false, reason: 'invalid' };
  const result = values.get(value);
  return result === undefined
    ? { available: false, reason: 'unrecognized' }
    : { available: true, value: result };
}

function seconds(value: unknown): Reading<number> {
  if (value === undefined || value === null) return { available: false, reason: 'missing' };
  return identifier(value) && value <= 3600
    ? { available: true, value }
    : { available: false, reason: 'invalid' };
}

function records(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > maximumRecords)
    throw new CloudError('invalid-response');
  return value;
}

/** Keep the first record per identity; malformed or duplicated identities are counted, not guessed. */
function unique<T extends { id: number }>(
  items: unknown[],
  decode: (item: Record<string, unknown>) => T | undefined,
): { values: T[]; rejected: number } {
  const values: T[] = [];
  const seen = new Set<number>();
  let rejected = 0;
  for (const item of items) {
    const decoded = isRecord(item) ? decode(item) : undefined;
    if (!decoded || seen.has(decoded.id)) {
      rejected += 1;
      continue;
    }
    seen.add(decoded.id);
    values.push(Object.freeze(decoded));
  }
  return { values, rejected };
}

function fieldUnion(items: unknown[]): string[] {
  return [...new Set(items.flatMap(fieldNames))].sort().slice(0, 64);
}

/** Counts numbers/booleans by value and anything else by type, never echoing text. */
function histogram(items: unknown[], field: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const raw = isRecord(item) ? item[field] : undefined;
    const key =
      (typeof raw === 'number' && Number.isFinite(raw)) || typeof raw === 'boolean'
        ? String(raw)
        : raw === null
          ? 'null'
          : typeof raw;
    if (key in counts || Object.keys(counts).length < 32) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Decodes `ControlPanel/GetState` → `response.state.status`. */
export function decodePanelState(
  value: unknown,
  context: { siteId: number; fromControlPanel: boolean; observedAtMs: number },
): PanelState {
  const status = isRecord(value) && isRecord(value.state) ? value.state.status : undefined;
  if (!isRecord(status)) throw new CloudError('invalid-response');
  const partitionRecords = records(status.partitions);
  const zoneRecords = records(status.zones);
  const partitions = unique(partitionRecords, (row) =>
    identifier(row.id)
      ? {
          id: row.id,
          arm: mapped(row.armedState, armStates),
          alarm: mapped(row.alarmState, alarmStates),
          exitDelaySeconds: seconds(row.exitDelayTO),
        }
      : undefined,
  );
  const zones = unique(zoneRecords, (row) =>
    identifier(row.zoneID)
      ? {
          id: row.zoneID,
          name:
            typeof row.zoneName === 'string' && row.zoneName.trim()
              ? row.zoneName.trim().slice(0, 64)
              : `Zone ${String(row.zoneID)}`,
          type: Number.isInteger(row.zoneType) ? (row.zoneType as number) : undefined,
          condition: mapped(row.status, zoneConditions),
        }
      : undefined,
  );
  return Object.freeze({
    siteId: context.siteId,
    source: context.fromControlPanel ? 'panel' : 'cloud',
    observedAtMs: context.observedAtMs,
    partitions: Object.freeze(partitions.values),
    zones: Object.freeze(zones.values),
    rejectedRecords: partitions.rejected + zones.rejected,
    evidence: Object.freeze({
      stateKeys: fieldNames(isRecord(value) ? value.state : undefined),
      statusKeys: fieldNames(status),
      partitionFields: fieldUnion(partitionRecords),
      zoneFields: fieldUnion(zoneRecords),
      armedStates: histogram(partitionRecords, 'armedState'),
      alarmStates: histogram(partitionRecords, 'alarmState'),
      zoneStatuses: histogram(zoneRecords, 'status'),
      zoneTypes: histogram(zoneRecords, 'zoneType'),
      zoneTroubles: histogram(zoneRecords, 'trouble'),
      partitionReadyStates: histogram(partitionRecords, 'readyState'),
      online: histogram(isRecord(value) ? [value.state] : [], 'isOnline'),
    }),
  });
}
