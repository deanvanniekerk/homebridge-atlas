import { CloudError, type CloudErrorCategory } from './cloud-error.js';
import type { ArmState, PanelState, PartitionState, ZoneState } from './panel-model.js';
import { bounded, systemScheduler, type Scheduler } from './scheduler.js';

export interface PanelGateway {
  /** Resource-owning gateways close their client, including shared authentication. */
  close?(): void;
  read(signal: AbortSignal): Promise<PanelState>;
  /** Transport acceptance only. Polling must confirm the partition state. */
  arm(partitionId: number, target: ArmState, signal: AbortSignal): Promise<void>;
}

export class CommandError extends Error {
  constructor(readonly category: 'busy' | 'unavailable' | 'unconfirmed') {
    super(
      category === 'busy'
        ? 'Another arm or disarm command is still in progress.'
        : category === 'unavailable'
          ? 'Fresh partition state is unavailable. The command was not sent.'
          : 'The panel did not report the requested state in time.',
    );
    this.name = 'CommandError';
  }
}

export type SiteStatus =
  'healthy' | 'stale' | 'auth-required' | 'permission-denied' | 'protocol-error' | 'unavailable';

export interface SiteSnapshot {
  readonly status: SiteStatus;
  readonly panel: PanelState | undefined;
  readonly lastSuccessMs: number | undefined;
  readonly failure: CloudErrorCategory | 'unconfirmed' | undefined;
  readonly retryAtMs: number;
  /** Requested arm states awaiting confirmation, by partition id. */
  readonly targets: ReadonlyMap<number, ArmState>;
}

const commandBudgetMs = 20_000;
const confirmIntervalMs = 3000;
const confirmWindowMs = 120_000;

interface Pending {
  target: ArmState;
  /** Only polls that start after acceptance can confirm the command. */
  acceptedAtMs: number;
  cancelExpiry: () => void;
}

/** One RISCO site: non-overlapping polls, freshness, a single active command and confirmation. */
export class SiteCoordinator {
  readonly #gateway: PanelGateway;
  readonly #scheduler: Scheduler;
  readonly #intervalMs: number;
  readonly #shutdown = new AbortController();
  readonly #subscribers = new Set<{ wake: () => void; close: () => void }>();
  readonly #pending = new Map<number, Pending>();
  #panel: PanelState | undefined;
  #lastSuccessMs: number | undefined;
  #failure: CloudErrorCategory | 'unconfirmed' | undefined;
  #retryAt = 0;
  #revision = 0;
  #started = false;
  #polling = false;
  #refreshRequested = false;
  #commandActive = false;
  #cancelPoll: (() => void) | undefined;
  #cancelFreshness: (() => void) | undefined;

  constructor(gateway: PanelGateway, options: { scheduler?: Scheduler; intervalMs?: number } = {}) {
    this.#gateway = gateway;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#intervalMs = options.intervalMs ?? 30_000;
    if (
      !Number.isFinite(this.#intervalMs) ||
      this.#intervalMs < 10_000 ||
      this.#intervalMs > 300_000
    )
      throw new CloudError('invalid-request');
  }

  start(): void {
    if (this.#started || this.#shutdown.signal.aborted) return;
    this.#started = true;
    void this.poll();
  }

  close(): void {
    if (this.#shutdown.signal.aborted) return;
    this.#shutdown.abort();
    this.#cancelPoll?.();
    this.#cancelPoll = undefined;
    this.#cancelFreshness?.();
    this.#cancelFreshness = undefined;
    for (const id of [...this.#pending.keys()]) this.settle(id);
    for (const subscriber of this.#subscribers) subscriber.close();
    this.#gateway.close?.();
  }

  snapshot(): SiteSnapshot {
    const now = this.#scheduler.now();
    const fresh =
      this.#lastSuccessMs !== undefined && now - this.#lastSuccessMs < 3 * this.#intervalMs;
    const status: SiteStatus =
      this.#failure === 'invalid-credentials' ||
      this.#failure === 'invalid-pin' ||
      this.#failure === 'site-selection'
        ? 'auth-required'
        : this.#failure === 'permission-denied'
          ? 'permission-denied'
          : this.#failure === 'invalid-response'
            ? 'protocol-error'
            : this.#lastSuccessMs === undefined
              ? 'unavailable'
              : fresh
                ? 'healthy'
                : 'stale';
    return Object.freeze({
      status,
      panel: this.#panel,
      lastSuccessMs: this.#lastSuccessMs,
      failure: this.#failure,
      retryAtMs: this.#retryAt,
      targets: new Map([...this.#pending].map(([id, pending]) => [id, pending.target])),
    });
  }

  /** A partition from fresh state only; anything else is unavailable to presentation. */
  partition(id: number): PartitionState | undefined {
    const snapshot = this.snapshot();
    return snapshot.status === 'healthy'
      ? snapshot.panel?.partitions.find((partition) => partition.id === id)
      : undefined;
  }

  zone(id: number): ZoneState | undefined {
    const snapshot = this.snapshot();
    return snapshot.status === 'healthy'
      ? snapshot.panel?.zones.find((zone) => zone.id === id)
      : undefined;
  }

  /** Latest-state stream: slow consumers coalesce updates rather than accumulating snapshots. */
  async *updates(signal?: AbortSignal): AsyncGenerator<SiteSnapshot, void, unknown> {
    const lifecycle = { ended: false };
    const subscriber = {
      wake: () => {},
      close: () => {
        lifecycle.ended = true;
        signal?.removeEventListener('abort', subscriber.close);
        this.#subscribers.delete(subscriber);
        subscriber.wake();
      },
    };
    const closed = () =>
      lifecycle.ended || this.#shutdown.signal.aborted || signal?.aborted === true;
    if (closed()) return;
    if (this.#subscribers.size >= 8) throw new CloudError('invalid-request');
    this.#subscribers.add(subscriber);
    signal?.addEventListener('abort', subscriber.close, { once: true });
    let revision = -1;
    try {
      while (!closed()) {
        if (revision === this.#revision)
          await new Promise<void>((resolve) => {
            subscriber.wake = resolve;
          });
        if (closed()) break;
        revision = this.#revision;
        yield this.snapshot();
      }
    } finally {
      subscriber.close();
    }
  }

  /**
   * Resolves when the cloud accepts the command; the requested state stays pending until a later
   * poll confirms it. Only a command still in transport is exclusive: a newer command (such as a
   * disarm during the exit delay) replaces a pending target. Never queued, never replayed.
   */
  async arm(partitionId: number, target: ArmState): Promise<void> {
    if (this.#shutdown.signal.aborted) throw new CloudError('cancelled');
    if (this.#commandActive) throw new CommandError('busy');
    const partition = this.partition(partitionId);
    if (!partition?.arm.available) throw new CommandError('unavailable');
    if (partition.arm.value === target && !this.#pending.has(partitionId)) return;
    this.#commandActive = true;
    this.settle(partitionId);
    if (this.#failure === 'unconfirmed') this.#failure = undefined;
    try {
      await bounded(this.#scheduler, commandBudgetMs, this.#shutdown.signal, (signal) =>
        this.#gateway.arm(partitionId, target, signal),
      );
      const pending: Pending = {
        target,
        acceptedAtMs: this.#scheduler.now(),
        cancelExpiry: this.#scheduler.after(confirmWindowMs, () => {
          if (this.#pending.get(partitionId) !== pending) return;
          this.#pending.delete(partitionId);
          this.#failure = 'unconfirmed';
          this.changed();
        }),
      };
      this.#pending.set(partitionId, pending);
    } catch (error) {
      this.retainRetry(error);
      throw error instanceof CloudError ? error : new CloudError('unavailable');
    } finally {
      this.#commandActive = false;
      this.changed();
      this.refresh();
    }
  }

  private settle(partitionId: number): void {
    this.#pending.get(partitionId)?.cancelExpiry();
    this.#pending.delete(partitionId);
  }

  private refresh(): void {
    if (!this.#started || this.#shutdown.signal.aborted) return;
    this.#refreshRequested = true;
    if (this.#polling) return;
    this.#cancelPoll?.();
    this.#cancelPoll = this.#scheduler.after(
      Math.max(0, this.#retryAt - this.#scheduler.now()),
      () => {
        void this.poll();
      },
    );
  }

  private async poll(): Promise<void> {
    this.#polling = true;
    this.#refreshRequested = false;
    this.#retryAt = 0;
    const startedAt = this.#scheduler.now();
    try {
      const panel = await bounded(this.#scheduler, 45_000, this.#shutdown.signal, (signal) =>
        this.#gateway.read(signal),
      );
      if (this.#shutdown.signal.aborted) return;
      this.#panel = panel;
      this.#lastSuccessMs = panel.observedAtMs;
      // An unconfirmed command stays reported until the next command, so it cannot be missed.
      if (this.#failure !== 'unconfirmed') this.#failure = undefined;
      for (const [id, pending] of this.#pending) {
        const partition = panel.partitions.find((candidate) => candidate.id === id);
        if (
          startedAt >= pending.acceptedAtMs &&
          partition?.arm.available &&
          partition.arm.value === pending.target
        )
          this.settle(id);
      }
    } catch (error) {
      this.retainRetry(error);
      if (!this.#shutdown.signal.aborted)
        this.#failure = error instanceof CloudError ? error.category : 'invalid-response';
    } finally {
      this.#polling = false;
      this.changed();
      if (!this.#shutdown.signal.aborted)
        this.#cancelPoll = this.#scheduler.after(this.nextPollDelay(), () => {
          void this.poll();
        });
    }
  }

  private nextPollDelay(): number {
    const base = this.#refreshRequested
      ? 0
      : this.#pending.size > 0
        ? confirmIntervalMs
        : this.#intervalMs;
    return Math.max(base, this.#retryAt - this.#scheduler.now());
  }

  private changed(): void {
    if (this.#shutdown.signal.aborted) return;
    this.#revision += 1;
    for (const subscriber of this.#subscribers) subscriber.wake();
    this.#cancelFreshness?.();
    this.#cancelFreshness = undefined;
    if (this.#lastSuccessMs === undefined) return;
    const expires = this.#lastSuccessMs + 3 * this.#intervalMs;
    const now = this.#scheduler.now();
    if (expires > now)
      this.#cancelFreshness = this.#scheduler.after(expires - now, () => {
        this.changed();
      });
  }

  private retainRetry(error: unknown): void {
    if (error instanceof CloudError)
      this.#retryAt = Math.max(this.#retryAt, this.#scheduler.now() + error.retryAfterMs);
  }
}
