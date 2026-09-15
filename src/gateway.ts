import type { RiscoClient } from './cloud-client.js';
import type { PanelGateway } from './coordinator.js';
import { CloudError } from './cloud-error.js';
import { decodePanelState, type ArmState, type PanelState } from './panel-model.js';
import { shapeOf } from './shape.js';
import { systemScheduler } from './scheduler.js';

/** Own the client lifecycle and translate cloud calls into normalized panel state. */
export class AtlasGateway implements PanelGateway {
  readonly #client: RiscoClient;
  readonly #now: () => number;
  #rejectedShape: unknown;
  readonly #reads = { panel: 0, cloud: 0, lastDurationMs: null as number | null };

  constructor(client: RiscoClient, options: { now?: () => number } = {}) {
    this.#client = client;
    this.#now = options.now ?? (() => systemScheduler.now());
  }

  close(): void {
    this.#client.close();
  }

  async read(signal: AbortSignal): Promise<PanelState> {
    const started = this.#now();
    const result = await this.#client.state({ signal });
    signal.throwIfAborted();
    this.#reads[result.fromControlPanel ? 'panel' : 'cloud'] += 1;
    this.#reads.lastDurationMs = Math.max(0, Math.round(this.#now() - started));
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

  /** Successful reads by source since start, and the latest read duration. */
  readStats(): { panel: number; cloud: number; lastDurationMs: number | null } {
    return { ...this.#reads };
  }

  /** Values-free structure of the latest reply that did not decode, for debug diagnostics. */
  rejectedShape(): unknown {
    return this.#rejectedShape ?? this.#client.rejectedShape();
  }

  async arm(partitionId: number, target: ArmState, signal: AbortSignal): Promise<void> {
    await this.#client.arm(partitionId, target, { signal });
  }
}
