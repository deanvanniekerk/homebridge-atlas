import { CloudError, type CloudErrorCategory } from '../cloud/cloud-error.js';
import type { RuntimeUpdate } from '../cloud/cloud-events.js';
import type { ArmState, PanelState, PartitionState, ZoneState } from './panel-model.js';
import { bounded, type Scheduler, systemScheduler } from './scheduler.js';

export interface PanelGateway {
  /** Resource-owning gateways close their client, including shared authentication. */
  close?(): void;
  /** `notBefore` asks for state at least as new as a pushed `LastStatusUpdate`. */
  read(signal: AbortSignal, options?: { notBefore?: number }): Promise<PanelState>;
  /** Hold a push stream open until it ends; optional, polling works without it. */
  watch?(
    signal: AbortSignal,
    handlers: { onOpen: () => void; onUpdate: (update: RuntimeUpdate) => void },
  ): Promise<void>;
  /** Transport acceptance only. Polling must confirm the partition state. */
  arm(partitionId: number, target: ArmState, signal: AbortSignal): Promise<void>;
}

export type CommandErrorCategory = 'busy' | 'unavailable' | 'unconfirmed' | 'not-ready' | 'offline';

const commandMessages: Record<CommandErrorCategory, string> = {
  busy: 'Another arm or disarm command is still in progress.',
  unavailable: 'Fresh partition state is unavailable. The command was not sent.',
  unconfirmed: 'The panel did not report the requested state in time.',
  'not-ready':
    'The panel reports the partition is not ready to arm (a zone is open or faulted). The command was not sent.',
  offline: 'The control panel is offline from RISCO Cloud. The command was not sent.',
};

export class CommandError extends Error {
  constructor(readonly category: CommandErrorCategory) {
    super(commandMessages[category]);
    this.name = 'CommandError';
  }
}

export type SiteStatus =
  | 'healthy'
  | 'stale'
  | 'auth-required'
  | 'permission-denied'
  | 'protocol-error'
  | 'unavailable';

export interface SiteSnapshot {
  readonly status: SiteStatus;
  readonly panel: PanelState | undefined;
  readonly lastSuccessMs: number | undefined;
  readonly failure: CloudErrorCategory | 'unconfirmed' | undefined;
  /** Vendor result code of the latest failure, when the cloud supplied one. */
  readonly failureCode: number | undefined;
  readonly retryAtMs: number;
  /**
   * Whether the control panel is disconnected from RISCO Cloud, from the most recent of the
   * panel's `isOnline` and a pushed `IsOffline`. Undefined when neither is known.
   */
  readonly offline: boolean | undefined;
  /** Requested arm states awaiting confirmation, by partition id. */
  readonly targets: ReadonlyMap<number, ArmState>;
  readonly stream: StreamStatus;
}

export interface StreamStatus {
  readonly mode: 'push' | 'poll';
  readonly connected: boolean;
  readonly connects: number;
  readonly disconnects: number;
  readonly updates: number;
  readonly lastUpdateMs: number | undefined;
  /** From receiving a pushed change to applying fresh state. */
  readonly lastUpdateLatencyMs: number | undefined;
  readonly lastFailure: CloudErrorCategory | undefined;
  /** Latest `IsOffline` pushed by the cloud. */
  readonly offline: boolean | undefined;
  /** How long the most recently ended connection stayed open. */
  readonly lastConnectionMs: number | undefined;
  /** Time without a pushed update before the most recently ended connection dropped. */
  readonly lastDropSilenceMs: number | undefined;
}

const commandBudgetMs = 20_000;
const confirmIntervalMs = 3000;
const confirmWindowMs = 120_000;
/** While the push stream is connected, polling is only a safety net. */
const safetyIntervalMs = 300_000;
const minimumRefreshGapMs = 1000;
const reconnectMaximumMs = 300_000;
/** A connection that lasted this long resets the reconnect backoff. */
const stableConnectionMs = 60_000;

interface Pending {
  target: ArmState;
  /** Only polls that start after acceptance can confirm the command. */
  acceptedAtMs: number;
  cancelExpiry: () => void;
}

/**
 * One RISCO site: non-overlapping polls, optional push-triggered refreshes, freshness, a single
 * active command and confirmation.
 */
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
  #failureCode: number | undefined;
  #retryAt = 0;
  #revision = 0;
  #started = false;
  #polling = false;
  #refreshRequested = false;
  #commandActive = false;
  #cancelPoll: (() => void) | undefined;
  #cancelFreshness: (() => void) | undefined;
  readonly #push: boolean;
  #stream: {
    -readonly [K in keyof StreamStatus]: StreamStatus[K];
  };
  #notBefore: number | undefined;
  #pushReceivedAt: number | undefined;
  #lastPushedStatusMs = -Infinity;
  #pushedOffline: { value: boolean; at: number } | undefined;
  /** State is presented until this time; set on success and shortened when push drops. */
  #freshUntil: number | undefined;
  #lastPollStartedAt = -Infinity;

  constructor(
    gateway: PanelGateway,
    options: { scheduler?: Scheduler; intervalMs?: number; push?: boolean } = {},
  ) {
    this.#gateway = gateway;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#intervalMs = options.intervalMs ?? 30_000;
    this.#push = options.push === true && gateway.watch !== undefined;
    this.#stream = {
      mode: this.#push ? 'push' : 'poll',
      connected: false,
      connects: 0,
      disconnects: 0,
      updates: 0,
      lastUpdateMs: undefined,
      lastUpdateLatencyMs: undefined,
      lastConnectionMs: undefined,
      lastDropSilenceMs: undefined,
      lastFailure: undefined,
      offline: undefined,
    };
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
    if (this.#push) void this.supervise();
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
    const fresh = this.#freshUntil !== undefined && now < this.#freshUntil;
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
      failureCode: this.#failure === undefined ? undefined : this.#failureCode,
      retryAtMs: this.#retryAt,
      offline: this.offline(),
      targets: new Map([...this.#pending].map(([id, pending]) => [id, pending.target])),
      stream: Object.freeze({ ...this.#stream }),
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
    if (this.offline() === true) throw new CommandError('offline');
    // Arming a partition the panel reports as not ready would fail or leave zones unprotected;
    // refuse locally. Disarming is never blocked.
    if (target !== 'disarmed' && partition.ready.available && !partition.ready.value)
      throw new CommandError('not-ready');
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
          this.#failureCode = undefined;
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
    this.#cancelPoll = this.#scheduler.after(this.refreshDelay(), () => {
      void this.poll();
    });
  }

  private refreshDelay(): number {
    const now = this.#scheduler.now();
    return Math.max(0, this.#retryAt - now, this.#lastPollStartedAt + minimumRefreshGapMs - now);
  }

  /** Keep the push stream open; each reconnect backs off, and a stable connection resets it. */
  private async supervise(): Promise<void> {
    let failures = 0;
    while (!this.stopped()) {
      // Mutated by the stream callbacks; a holder keeps the flow analysis honest.
      const connection: { openedAt: number | undefined; retryAfterMs: number } = {
        openedAt: undefined,
        retryAfterMs: 0,
      };
      try {
        await this.#gateway.watch?.(this.#shutdown.signal, {
          onOpen: () => {
            if (this.stopped()) return;
            connection.openedAt = this.#scheduler.now();
            this.#stream.connected = true;
            this.#stream.connects += 1;
            this.#stream.lastFailure = undefined;
            this.changed();
            // State may have changed while disconnected; read it once the stream is listening.
            this.refreshFromCache();
          },
          onUpdate: (update) => {
            this.pushed(update);
          },
        });
      } catch (error) {
        if (!this.stopped()) {
          this.#stream.lastFailure = error instanceof CloudError ? error.category : 'unavailable';
          connection.retryAfterMs = error instanceof CloudError ? error.retryAfterMs : 0;
        }
      }
      if (this.stopped()) return;
      const { openedAt, retryAfterMs } = connection;
      if (openedAt !== undefined) {
        const droppedAt = this.#scheduler.now();
        this.#stream.connected = false;
        this.#stream.disconnects += 1;
        this.#stream.lastConnectionMs = droppedAt - openedAt;
        this.#stream.lastDropSilenceMs =
          droppedAt - Math.max(openedAt, this.#stream.lastUpdateMs ?? -Infinity);
        // A drop is not evidence that state changed: keep it for one polling window while the
        // immediate refresh and reconnect run.
        if (this.#freshUntil !== undefined)
          this.#freshUntil = Math.min(this.#freshUntil, droppedAt + 3 * this.#intervalMs);
        this.changed();
        this.refreshFromCache();
      }
      failures =
        openedAt !== undefined && this.#scheduler.now() - openedAt >= stableConnectionMs
          ? 1
          : failures + 1;
      const delay = Math.max(
        retryAfterMs,
        Math.min(reconnectMaximumMs, 1000 * 2 ** Math.min(failures - 1, 9)),
      );
      await new Promise<void>((resolve) => {
        const done = () => {
          cancel();
          this.#shutdown.signal.removeEventListener('abort', done);
          resolve();
        };
        const cancel = this.#scheduler.after(delay, done);
        this.#shutdown.signal.addEventListener('abort', done, { once: true });
      });
    }
  }

  /**
   * Refresh around a stream open or drop. Once a pushed status time is known, the cloud cache is
   * as current as the panel for this (observed: no escalations), so the read avoids the panel.
   */
  private refreshFromCache(): void {
    if (Number.isFinite(this.#lastPushedStatusMs))
      this.#notBefore = Math.max(this.#notBefore ?? -Infinity, this.#lastPushedStatusMs);
    this.refresh();
  }

  private offline(): boolean | undefined {
    const panel = this.#panel?.online.available
      ? { value: !this.#panel.online.value, at: this.#panel.observedAtMs }
      : undefined;
    const pushed = this.#pushedOffline;
    // A push received at the same instant as a read arrived after it.
    if (panel && pushed) return (pushed.at >= panel.at ? pushed : panel).value;
    return (panel ?? pushed)?.value;
  }

  private stopped(): boolean {
    return this.#shutdown.signal.aborted;
  }

  private pushed(update: RuntimeUpdate): void {
    if (this.#shutdown.signal.aborted) return;
    this.#stream.updates += 1;
    this.#stream.lastUpdateMs = this.#scheduler.now();
    if (update.offline !== undefined) {
      this.#stream.offline = update.offline;
      this.#pushedOffline = { value: update.offline, at: this.#scheduler.now() };
    }
    const status = update.statusUpdatedAtMs;
    // Event-log-only notifications repeat an already-seen status time and need no read.
    if (status !== undefined && status <= this.#lastPushedStatusMs) {
      this.changed();
      return;
    }
    if (status !== undefined) {
      this.#lastPushedStatusMs = status;
      this.#notBefore = Math.max(this.#notBefore ?? -Infinity, status);
    }
    this.#pushReceivedAt ??= this.#scheduler.now();
    this.refresh();
  }

  private async poll(): Promise<void> {
    this.#polling = true;
    this.#refreshRequested = false;
    this.#retryAt = 0;
    const startedAt = this.#scheduler.now();
    this.#lastPollStartedAt = startedAt;
    // Command confirmation always asks the panel; pushed changes may use the cloud cache.
    const notBefore = this.#pending.size === 0 ? this.#notBefore : undefined;
    const pushReceivedAt = this.#pushReceivedAt;
    try {
      const panel = await bounded(this.#scheduler, 45_000, this.#shutdown.signal, (signal) =>
        notBefore === undefined
          ? this.#gateway.read(signal)
          : this.#gateway.read(signal, { notBefore }),
      );
      if (this.#shutdown.signal.aborted) return;
      this.#panel = panel;
      this.#lastSuccessMs = panel.observedAtMs;
      this.#freshUntil = panel.observedAtMs + this.freshnessWindow();
      if (
        this.#notBefore !== undefined &&
        (this.#notBefore === notBefore ||
          (panel.statusUpdatedAtMs !== undefined && panel.statusUpdatedAtMs >= this.#notBefore))
      )
        this.#notBefore = undefined;
      if (pushReceivedAt !== undefined && this.#pushReceivedAt === pushReceivedAt) {
        this.#stream.lastUpdateLatencyMs = Math.max(0, this.#scheduler.now() - pushReceivedAt);
        this.#pushReceivedAt = undefined;
      }
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
      if (!this.#shutdown.signal.aborted) {
        this.#failure = error instanceof CloudError ? error.category : 'invalid-response';
        this.#failureCode = error instanceof CloudError ? error.vendorResult : undefined;
      }
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
    if (this.#refreshRequested) return this.refreshDelay();
    const base =
      this.#pending.size > 0
        ? confirmIntervalMs
        : this.#stream.connected
          ? safetyIntervalMs
          : this.#intervalMs;
    return Math.max(base, this.#retryAt - this.#scheduler.now());
  }

  /** Connected push keeps state fresh between safety polls; otherwise three poll intervals. */
  private freshnessWindow(): number {
    return this.#stream.connected ? safetyIntervalMs + this.#intervalMs : 3 * this.#intervalMs;
  }

  private changed(): void {
    if (this.#shutdown.signal.aborted) return;
    this.#revision += 1;
    for (const subscriber of this.#subscribers) subscriber.wake();
    this.#cancelFreshness?.();
    this.#cancelFreshness = undefined;
    if (this.#freshUntil === undefined) return;
    const expires = this.#freshUntil;
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
