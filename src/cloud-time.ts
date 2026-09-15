import { setTimeout as sleep } from 'node:timers/promises';
import { CloudError } from './cloud-error.js';

function safeError(error: unknown): CloudError {
  return error instanceof CloudError ? error : new CloudError('unavailable');
}

export interface CloudClock {
  /** Epoch milliseconds; monotonic within one client lifetime. */
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
}

export const systemClock: CloudClock = {
  now: () => performance.timeOrigin + performance.now(),
  sleep: async (ms, signal) => {
    await sleep(ms, undefined, { signal });
  },
  random: Math.random,
};

/** Each caller owns its deadline. An aborted waiter never aborts shared authentication. */
export class Budget {
  readonly signal: AbortSignal;
  readonly #timeout = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #until: number;

  constructor(
    ms: number,
    readonly clock: CloudClock,
    signals: AbortSignal[],
  ) {
    this.#until = clock.now() + ms;
    this.#timer = setTimeout(() => {
      this.#timeout.abort();
    }, ms);
    this.signal = AbortSignal.any([...signals, this.#timeout.signal]);
  }

  remaining(): number {
    return Math.max(0, this.#until - this.clock.now());
  }

  check(): void {
    if (this.#timeout.signal.aborted || this.remaining() <= 0) throw new CloudError('timeout');
    if (this.signal.aborted) throw new CloudError('cancelled');
  }

  async wait<T>(promise: Promise<T>): Promise<T> {
    // Attach both handlers even when already aborted: shared work may fail later.
    return new Promise<T>((resolve, reject) => {
      const aborted = () => {
        try {
          this.check();
        } catch (error) {
          reject(safeError(error));
        }
      };
      this.signal.addEventListener('abort', aborted, { once: true });
      promise.then(
        (value) => {
          this.signal.removeEventListener('abort', aborted);
          try {
            this.check();
            resolve(value);
          } catch (error) {
            reject(safeError(error));
          }
        },
        (error: unknown) => {
          this.signal.removeEventListener('abort', aborted);
          try {
            this.check();
            reject(safeError(error));
          } catch (cancelled) {
            reject(safeError(cancelled));
          }
        },
      );
      aborted();
    });
  }

  dispose(): void {
    clearTimeout(this.#timer);
    // Also destroy work if an elapsed-clock check beat the timer's event-loop turn.
    this.#timeout.abort();
  }
}

export function deadline(value: number | undefined, maximum: number): number {
  const result = value ?? maximum;
  if (!Number.isFinite(result) || result <= 0 || result > maximum)
    throw new CloudError('invalid-request');
  return result;
}
