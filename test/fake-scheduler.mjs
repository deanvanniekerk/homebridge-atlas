export class FakeScheduler {
  time = 1_000_000;
  tasks = new Map();
  sequence = 0;
  now = () => this.time;
  after = (ms, callback) => {
    const id = ++this.sequence;
    this.tasks.set(id, { at: this.time + ms, callback });
    return () => this.tasks.delete(id);
  };
  async advance(ms) {
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
  async flush() {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  }
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
