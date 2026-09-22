import type { Scheduler } from './scheduler.js';

export class FakeScheduler implements Scheduler {
  time = 1_000_000;
  tasks = new Map<number, { at: number; callback: () => void }>();
  sequence = 0;
  now = () => this.time;
  after = (ms: number, callback: () => void) => {
    const id = ++this.sequence;
    this.tasks.set(id, { at: this.time + ms, callback });
    return () => {
      this.tasks.delete(id);
    };
  };
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      await this.flush();
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
    this.time = end;
    await this.flush();
  }
  async flush(): Promise<void> {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  }
}

export function deferred<T = void>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
