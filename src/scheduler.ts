import { CloudError } from './cloud-error.js';

export interface Scheduler {
  now(): number;
  after(ms: number, callback: () => void): () => void;
}

export const systemScheduler: Scheduler = {
  now: () => performance.timeOrigin + performance.now(),
  after: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

/** Own both promise settlement and cancellation, including an uncooperative transport. */
export async function bounded<T>(
  scheduler: Scheduler,
  ms: number,
  parent: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let expired = false;
  const cancelTimer = scheduler.after(ms, () => {
    expired = true;
    controller.abort();
  });
  const parentAborted = () => {
    controller.abort();
  };
  parent.addEventListener('abort', parentAborted, { once: true });
  try {
    return await new Promise<T>((resolve, reject) => {
      const cancelled = () => {
        reject(new CloudError(expired ? 'timeout' : 'cancelled'));
      };
      controller.signal.addEventListener('abort', cancelled, { once: true });
      if (parent.aborted) controller.abort();
      if (controller.signal.aborted) return;
      Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) throw new CloudError(expired ? 'timeout' : 'cancelled');
          return work(controller.signal);
        })
        .then(resolve, (error: unknown) => {
          reject(error instanceof Error ? error : new CloudError('unavailable'));
        })
        .finally(() => {
          controller.signal.removeEventListener('abort', cancelled);
        });
    });
  } finally {
    cancelTimer();
    parent.removeEventListener('abort', parentAborted);
    controller.abort();
  }
}
