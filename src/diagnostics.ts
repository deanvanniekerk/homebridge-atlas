import type { SiteSnapshot } from './coordinator.js';
import type { PanelState, Reading } from './panel-model.js';
import { systemScheduler } from './scheduler.js';

interface DiagnosticOptions {
  /** Values-free structure of a reply that failed to decode, when available. */
  rejectedShape?: () => unknown;
  /** Successful reads by source and the latest read duration. */
  readStats?: () => {
    panel: number;
    cloud: number;
    escalations?: number;
    lastDurationMs: number | null;
  };
  /** Push stream message counts by event name. */
  eventStats?: () => Record<string, number>;
  now?: () => number;
  pluginVersion: string;
  homebridgeVersion: string;
  debug?: boolean;
}

function version(value: string): string {
  return /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)\.\d{1,6})?$/.test(value)
    ? value
    : 'unknown';
}

function reading<T>(value: Reading<T>): string {
  return value.available ? String(value.value) : `unavailable:${value.reason}`;
}

function elapsed(later: number, earlier: number | undefined): number | null {
  return earlier !== undefined && Number.isFinite(later) && Number.isFinite(earlier)
    ? Math.max(0, Math.round(later - earlier))
    : null;
}

/** Sanitized panel summary: ids, enumerated states, counts and vendor field names. No zone names. */
export function panelReport(panel: PanelState) {
  const conditions: Record<string, number> = {};
  for (const zone of panel.zones) {
    const key = reading(zone.condition);
    conditions[key] = (conditions[key] ?? 0) + 1;
  }
  return {
    source: panel.source,
    partitions: panel.partitions.slice(0, 32).map((partition) => ({
      id: partition.id,
      arm: reading(partition.arm),
      alarm: reading(partition.alarm),
      exitDelaySeconds: reading(partition.exitDelaySeconds),
    })),
    zones: { count: panel.zones.length, conditions },
    rejectedRecords: panel.rejectedRecords,
    evidence: panel.evidence,
  };
}

/** Projects site state onto an allowlist; never stringify an input object or error. */
export class Diagnostics {
  readonly #now: () => number;
  readonly #runtime;
  readonly #write: (message: string) => void;
  readonly #debug: boolean;
  readonly #rejectedShape: (() => unknown) | undefined;
  readonly #readStats: DiagnosticOptions['readStats'];
  readonly #eventStats: DiagnosticOptions['eventStats'];
  #lastReportMs = -Infinity;

  constructor(write: (message: string) => void, options: DiagnosticOptions) {
    this.#write = write;
    this.#debug = options.debug === true;
    this.#rejectedShape = options.rejectedShape;
    this.#readStats = options.readStats;
    this.#eventStats = options.eventStats;
    this.#now = options.now ?? (() => systemScheduler.now());
    this.#runtime = Object.freeze({
      plugin: version(options.pluginVersion),
      node: version(process.versions.node),
      homebridge: version(options.homebridgeVersion),
    });
  }

  observe(snapshot: SiteSnapshot): void {
    const now = this.#now();
    const evidence = snapshot.panel !== undefined || snapshot.status === 'protocol-error';
    if (!this.#debug || !evidence || now - this.#lastReportMs < 300_000) return;
    this.#lastReportMs = now;
    this.#write(`Diagnostic report: ${JSON.stringify(this.report(snapshot))}`);
  }

  report(snapshot: SiteSnapshot) {
    const now = this.#now();
    return {
      runtime: this.#runtime,
      site: {
        status: snapshot.status,
        failure: snapshot.failure ?? null,
        failureCode: snapshot.failureCode ?? null,
        lastSuccessAgeMs: elapsed(now, snapshot.lastSuccessMs),
        retryInMs: elapsed(snapshot.retryAtMs, now),
        pendingTargets: Object.fromEntries(snapshot.targets),
        reads: this.#readStats?.() ?? null,
      },
      stream: {
        mode: snapshot.stream.mode,
        connected: snapshot.stream.connected,
        connects: snapshot.stream.connects,
        disconnects: snapshot.stream.disconnects,
        updates: snapshot.stream.updates,
        lastUpdateAgeMs: elapsed(now, snapshot.stream.lastUpdateMs),
        lastUpdateLatencyMs: snapshot.stream.lastUpdateLatencyMs ?? null,
        lastFailure: snapshot.stream.lastFailure ?? null,
        offline: snapshot.stream.offline ?? null,
        events: this.#eventStats?.() ?? null,
      },
      panel: snapshot.panel ? panelReport(snapshot.panel) : null,
      rejectedShape:
        snapshot.status === 'protocol-error' ? (this.#rejectedShape?.() ?? null) : null,
    };
  }
}
