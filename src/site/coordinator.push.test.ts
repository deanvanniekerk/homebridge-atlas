import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CloudError } from '../cloud/cloud-error.js';
import { panel } from '../cloud/fake-cloud.test-support.js';
import { SiteCoordinator } from './coordinator.js';
import { deferred, FakeScheduler } from './fake-scheduler.test-support.js';
import { decodePanelState } from './panel-model.js';

// Synthetic push contract: timing assertions describe scheduling, not measured vendor latency.
function harness(options = {}) {
  const scheduler = new FakeScheduler();
  const state = { armedState: 1, statusUpdatedAt: '2026-09-15T17:00:00Z' };
  const reads = [];
  const streams = [];
  const gateway = {
    read: async (_signal, readOptions = {}) => {
      reads.push({ at: scheduler.now(), notBefore: readOptions.notBefore });
      if (state.fail) throw state.fail;
      const value = panel({
        partitions: [{ id: 0, armedState: state.armedState, alarmState: 0, exitDelayTO: 0 }],
      }).response;
      value.state.lastStatusUpdate = state.statusUpdatedAt;
      return decodePanelState(value, {
        siteId: 7,
        fromControlPanel: true,
        observedAtMs: scheduler.now(),
      });
    },
    arm: async () => {},
    watch: (signal, handlers) => {
      const stream = { ...deferred(), handlers };
      signal.addEventListener('abort', () => stream.reject(new CloudError('cancelled')), {
        once: true,
      });
      streams.push(stream);
      if (options.openImmediately !== false) handlers.onOpen();
      return stream.promise;
    },
  };
  const coordinator = new SiteCoordinator(gateway, {
    scheduler,
    intervalMs: 30_000,
    push: options.push ?? true,
  });
  return { scheduler, state, reads, streams, coordinator };
}

const push = (h, status) =>
  h.streams.at(-1).handlers.onUpdate({
    offline: false,
    statusUpdatedAtMs: Date.parse(status),
    eventUpdatedAtMs: Date.parse(status),
  });

test('a connected stream replaces 30-second polling with a five-minute safety poll and stays fresh', async () => {
  const h = harness();
  h.coordinator.start();
  await h.scheduler.advance(1000);
  assert.equal(h.streams.length, 1);
  assert.equal(h.coordinator.snapshot().stream.connected, true);
  const initial = h.reads.length;
  assert.ok(initial >= 1);
  await h.scheduler.advance(299_000);
  assert.equal(h.reads.length, initial, 'no 30-second polls while connected');
  assert.equal(h.coordinator.snapshot().status, 'healthy', 'fresh beyond three poll intervals');
  await h.scheduler.advance(1000);
  assert.equal(h.reads.length, initial + 1, 'safety poll after five minutes');
  h.coordinator.close();
  assert.equal(h.scheduler.tasks.size, 0);
});

test('a pushed status change triggers a cache-first refresh, once per status time, and records latency', async () => {
  const h = harness();
  h.coordinator.start();
  await h.scheduler.advance(1000);
  const before = h.reads.length;
  h.state.armedState = 3;
  h.state.statusUpdatedAt = '2026-09-15T17:00:05Z';
  push(h, '2026-09-15T17:00:05Z');
  push(h, '2026-09-15T17:00:05Z');
  // The previous poll started this instant; refreshes keep one second between starts.
  await h.scheduler.advance(1000);
  assert.equal(h.reads.length, before + 1);
  assert.equal(h.reads.at(-1).notBefore, Date.parse('2026-09-15T17:00:05Z'));
  assert.equal(h.coordinator.partition(0).arm.value, 'armed');
  const stream = h.coordinator.snapshot().stream;
  assert.equal(stream.updates, 2);
  assert.equal(stream.lastUpdateLatencyMs, 1000);
  push(h, '2026-09-15T17:00:04Z');
  await h.scheduler.advance(5000);
  assert.equal(h.reads.length, before + 1, 'older or repeated status times need no read');
  h.coordinator.close();
});

test('bursts of pushes coalesce into refreshes at least one second apart', async () => {
  const h = harness();
  h.coordinator.start();
  await h.scheduler.advance(1000);
  const before = h.reads.length;
  for (let second = 1; second <= 5; second += 1) {
    push(h, `2026-09-15T17:00:1${second}Z`);
    await h.scheduler.advance(200);
  }
  await h.scheduler.advance(2000);
  assert.ok(h.reads.length - before <= 2, `got ${h.reads.length - before} refreshes`);
  assert.equal(h.reads.at(-1).notBefore, Date.parse('2026-09-15T17:00:15Z'));
  h.coordinator.close();
});

test('a dropped stream polls immediately, falls back to the poll interval and reconnects with backoff', async () => {
  const h = harness();
  h.coordinator.start();
  await h.scheduler.advance(1000);
  const before = h.reads.length;
  h.streams[0].resolve();
  await h.scheduler.flush();
  assert.equal(h.coordinator.snapshot().stream.connected, false);
  assert.equal(h.coordinator.snapshot().stream.disconnects, 1);
  await h.scheduler.advance(1000);
  assert.equal(h.reads.length, before + 1, 'refresh on disconnect');
  assert.equal(h.streams.length, 2, 'first reconnect after one second');
  h.streams[1].reject(new CloudError('unavailable'));
  await h.scheduler.advance(1000);
  assert.equal(h.streams.length, 2);
  assert.equal(h.coordinator.snapshot().stream.lastFailure, 'unavailable');
  await h.scheduler.advance(1000);
  assert.equal(h.streams.length, 3, 'backoff doubles');
  assert.equal(h.coordinator.snapshot().stream.lastFailure, undefined, 'cleared on reconnect');
  h.coordinator.close();
});

test('an idle stream dropped by the network keeps state fresh and reconnects with a cache refresh', async () => {
  // Observed on the owner's account: the stream closed 120 s after the last pushed change.
  const h = harness();
  h.coordinator.start();
  await h.scheduler.advance(1000);
  h.state.statusUpdatedAt = '2026-09-15T17:00:05Z';
  push(h, '2026-09-15T17:00:05Z');
  await h.scheduler.advance(1000);
  const lastRead = h.reads.at(-1).at;
  await h.scheduler.advance(120_000);
  h.streams[0].reject(new CloudError('unavailable'));
  await h.scheduler.flush();
  const snapshot = h.coordinator.snapshot();
  assert.equal(snapshot.status, 'healthy', 'a drop alone does not expire state');
  assert.equal(snapshot.stream.lastDropSilenceMs, 121_000);
  assert.equal(snapshot.stream.lastConnectionMs, 122_000);
  const reads = h.reads.length;
  await h.scheduler.advance(1000);
  assert.equal(h.streams.length, 2, 'reconnected after one second');
  assert.ok(h.reads.length > reads, 'refreshed after the drop');
  assert.ok(
    h.reads.slice(reads).every((read) => read.notBefore === Date.parse('2026-09-15T17:00:05Z')),
    'drop and reconnect refreshes use the cloud cache, not the panel',
  );
  assert.ok(h.reads.at(-1).at > lastRead);
  assert.equal(h.coordinator.snapshot().status, 'healthy');
  h.coordinator.close();
});

test('state that cannot be refreshed after a drop expires one polling window later', async () => {
  const h = harness();
  h.coordinator.start();
  await h.scheduler.advance(1000);
  await h.scheduler.advance(200_000);
  h.state.fail = new CloudError('unavailable');
  h.streams[0].reject(new CloudError('unavailable'));
  await h.scheduler.flush();
  assert.equal(h.coordinator.snapshot().status, 'healthy');
  await h.scheduler.advance(89_000);
  assert.equal(h.coordinator.snapshot().status, 'healthy');
  await h.scheduler.advance(1000);
  assert.equal(h.coordinator.snapshot().status, 'stale', 'expires 90 s after the drop');
  h.coordinator.close();
});

test('while push is unavailable, polling and freshness follow the configured interval', async () => {
  const h = harness({ openImmediately: false });
  h.coordinator.start();
  await h.scheduler.flush();
  h.streams[0].reject(new CloudError('session-contention', 60_000));
  await h.scheduler.flush();
  assert.equal(h.coordinator.snapshot().stream.lastFailure, 'session-contention');
  const first = h.reads.length;
  await h.scheduler.advance(30_000);
  assert.equal(h.reads.length, first + 1, '30-second polling without push');
  await h.scheduler.advance(29_000);
  assert.equal(h.streams.length, 1, 'reconnect waits for retry-after');
  await h.scheduler.advance(1000);
  assert.equal(h.streams.length, 2);
  h.coordinator.close();
});

test('polling mode never opens a stream', async () => {
  const h = harness({ push: false });
  h.coordinator.start();
  await h.scheduler.advance(60_000);
  assert.equal(h.streams.length, 0);
  assert.equal(h.coordinator.snapshot().stream.mode, 'poll');
  assert.equal(h.reads.length, 3);
  h.coordinator.close();
});
