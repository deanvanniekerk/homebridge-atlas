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

  constructor(client: RiscoClient, options: { now?: () => number } = {}) {
    this.#client = client;
    this.#now = options.now ?? (() => systemScheduler.now());
  }

  close(): void {
    this.#client.close();
  }

  async read(signal: AbortSignal): Promise<PanelState> {
    const result = await this.#client.state({ signal });
    signal.throwIfAborted();
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

  /** Values-free structure of the latest reply that did not decode, for debug diagnostics. */
  rejectedShape(): unknown {
    return this.#rejectedShape ?? this.#client.rejectedShape();
  }

  async arm(partitionId: number, target: ArmState, signal: AbortSignal): Promise<void> {
    await this.#client.arm(partitionId, target, { signal });
  }
}
