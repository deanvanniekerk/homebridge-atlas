import type { RiscoClient, StateResult } from './cloud-client.js';
import { decodeRuntimeUpdate, type RuntimeUpdate } from './cloud-events.js';
import type { PanelGateway } from './coordinator.js';
import { CloudError } from './cloud-error.js';
import { decodePanelState, type ArmState, type PanelState } from './panel-model.js';
import { shapeOf } from './shape.js';
import { systemScheduler } from './scheduler.js';

export interface ReadStats {
  panel: number;
  cloud: number;
  /** Cached reads older than the pushed change that triggered them, re-read from the panel. */
  escalations: number;
  lastDurationMs: number | null;
}

/** Own the client lifecycle and translate cloud calls into normalized panel state. */
export class AtlasGateway implements PanelGateway {
  readonly #client: RiscoClient;
  readonly #now: () => number;
  #rejectedShape: unknown;
  readonly #reads: ReadStats = { panel: 0, cloud: 0, escalations: 0, lastDurationMs: null };
  readonly #events = new Map<string, number>();

  constructor(client: RiscoClient, options: { now?: () => number } = {}) {
    this.#client = client;
    this.#now = options.now ?? (() => systemScheduler.now());
  }

  close(): void {
    this.#client.close();
  }

  /**
   * With `notBefore` (a pushed `LastStatusUpdate`), read the cloud's cached state first and only
   * ask the panel when the cache does not yet reflect that change.
   */
  async read(signal: AbortSignal, options: { notBefore?: number } = {}): Promise<PanelState> {
    const started = this.#now();
    try {
      if (options.notBefore !== undefined) {
        const cached = this.decode(await this.#client.state({ signal, preferCache: true }), signal);
        if (cached.statusUpdatedAtMs !== undefined && cached.statusUpdatedAtMs >= options.notBefore)
          return cached;
        this.#reads.escalations += 1;
      }
      return this.decode(await this.#client.state({ signal }), signal);
    } finally {
      this.#reads.lastDurationMs = Math.max(0, Math.round(this.#now() - started));
    }
  }

  async watch(
    signal: AbortSignal,
    handlers: { onOpen: () => void; onUpdate: (update: RuntimeUpdate) => void },
  ): Promise<void> {
    await this.#client.events(
      {
        onOpen: handlers.onOpen,
        onMessage: (message) => {
          const name = /^[A-Za-z0-9_]{1,32}$/.test(message.event) ? message.event : '?';
          if (this.#events.has(name) || this.#events.size < 16)
            this.#events.set(name, (this.#events.get(name) ?? 0) + 1);
          if (message.event !== 'runtimeUpdate') return;
          let update: RuntimeUpdate;
          try {
            update = decodeRuntimeUpdate(message.data);
          } catch {
            // An undecodable notification still means something changed.
            update = {
              offline: undefined,
              statusUpdatedAtMs: undefined,
              eventUpdatedAtMs: undefined,
            };
          }
          handlers.onUpdate(update);
        },
      },
      { signal },
    );
  }

  /** Successful reads by source since start, and the latest read duration. */
  readStats(): ReadStats {
    return { ...this.#reads };
  }

  /** Stream message counts by event name since start. */
  eventStats(): Record<string, number> {
    return Object.fromEntries(this.#events);
  }

  /** Values-free structure of the latest reply that did not decode, for debug diagnostics. */
  rejectedShape(): unknown {
    return this.#rejectedShape ?? this.#client.rejectedShape();
  }

  async arm(partitionId: number, target: ArmState, signal: AbortSignal): Promise<void> {
    await this.#client.arm(partitionId, target, { signal });
  }

  private decode(result: StateResult, signal: AbortSignal): PanelState {
    signal.throwIfAborted();
    this.#reads[result.fromControlPanel ? 'panel' : 'cloud'] += 1;
    try {
      const panel = decodePanelState(result.value, {
        siteId: result.siteId,
        fromControlPanel: result.fromControlPanel,
        observedAtMs: this.#now(),
      });
      this.#rejectedShape = undefined;
      return panel;
    } catch (error) {
      if (error instanceof CloudError && error.category === 'invalid-response')
        this.#rejectedShape = { stage: 'state', shape: shapeOf(result.value) };
      throw error;
    }
  }
}
