import type { RiscoClient } from './cloud-client.js';
import type { PanelGateway } from './coordinator.js';
import { decodePanelState, type ArmState, type PanelState } from './panel-model.js';
import { systemScheduler } from './scheduler.js';

/** Own the client lifecycle and translate cloud calls into normalized panel state. */
export class AtlasGateway implements PanelGateway {
  readonly #client: RiscoClient;
  readonly #now: () => number;

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
    return decodePanelState(result.value, {
      siteId: result.siteId,
      fromControlPanel: result.fromControlPanel,
      observedAtMs: this.#now(),
    });
  }

  async arm(partitionId: number, target: ArmState, signal: AbortSignal): Promise<void> {
    await this.#client.arm(partitionId, target, { signal });
  }
}
