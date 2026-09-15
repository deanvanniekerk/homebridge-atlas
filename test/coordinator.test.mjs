import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudError } from '../dist/cloud-error.js';
import { SiteCoordinator } from '../dist/coordinator.js';
import { decodePanelState } from '../dist/panel-model.js';
import { deferred, FakeScheduler } from './fake-scheduler.mjs';
import { panel } from './fake-cloud.mjs';

// Synthetic domain contract: no assertion here establishes physical panel behavior.
function sample(scheduler, armedState = 1, fromControlPanel = true) {
  return decodePanelState(
    panel({ partitions: [{ id: 0, armedState, alarmState: 0, exitDelayTO: 0 }] }).response,
    { siteId: 7, fromControlPanel, observedAtMs: scheduler.now() },
  );
}

function harness(options = {}) {
  const scheduler = new FakeScheduler();
  const panelState = { armedState: 1, fail: undefined };
  const reads = [];
  const arms = [];
  const gateway = {
    read: async () => {
      reads.push(scheduler.now());
      if (panelState.fail) throw panelState.fail;
      return sample(scheduler, panelState.armedState);
    },
    arm: async (partitionId, target) => {
      arms.push([partitionId, target]);
      if (options.arm) await options.arm(partitionId, target);
    },
  };
  const coordinator = new SiteCoordinator(gateway, { scheduler, intervalMs: 30_000 });
  return { scheduler, coordinator, panelState, reads, arms };
}

test('polls without overlap from cycle completion and exposes fresh partitions only', async () => {
  const scheduler = new FakeScheduler();
  const blocked = deferred();
  let reads = 0;
  const coordinator = new SiteCoordinator(
    {
      read: async () => {
        reads += 1;
        return reads === 1 ? blocked.promise : sample(scheduler);
      },
      arm: async () => {},
    },
    { scheduler },
  );
  coordinator.start();
  coordinator.start();
  await scheduler.flush();
  assert.equal(coordinator.snapshot().status, 'unavailable');
  assert.equal(coordinator.partition(0), undefined);
  await scheduler.advance(40_000);
  assert.equal(reads, 1);
  blocked.resolve(sample(scheduler));
  await scheduler.flush();
  assert.equal(coordinator.snapshot().status, 'healthy');
  assert.equal(coordinator.partition(0).arm.value, 'disarmed');
  assert.equal(coordinator.zone(1).condition.value, 'triggered');
  await scheduler.advance(29_999);
  assert.equal(reads, 1);
  await scheduler.advance(1);
  assert.equal(reads, 2);
  coordinator.close();
  assert.equal(scheduler.tasks.size, 0);
});

test('transient failures keep state for three intervals, then go stale; auth failures are distinct', async () => {
  const h = harness();
  h.coordinator.start();
  await h.scheduler.flush();
  h.panelState.fail = new CloudError('unavailable');
  await h.scheduler.advance(89_999);
  assert.equal(h.coordinator.snapshot().status, 'healthy');
  assert.equal(h.coordinator.snapshot().failure, 'unavailable');
  await h.scheduler.advance(1);
  assert.equal(h.coordinator.snapshot().status, 'stale');
  assert.equal(h.coordinator.partition(0), undefined);
  h.panelState.fail = new CloudError('invalid-pin');
  await h.scheduler.advance(30_000);
  assert.equal(h.coordinator.snapshot().status, 'auth-required');
  h.panelState.fail = undefined;
  await h.scheduler.advance(30_000);
  assert.equal(h.coordinator.snapshot().status, 'healthy');
  assert.equal(h.coordinator.snapshot().failure, undefined);
  h.coordinator.close();
});

test('an accepted arm stays pending until a later poll confirms it, polling quickly meanwhile', async () => {
  const h = harness();
  h.coordinator.start();
  await h.scheduler.flush();
  await h.coordinator.arm(0, 'armed');
  assert.deepEqual(h.arms, [[0, 'armed']]);
  assert.equal(h.coordinator.snapshot().targets.get(0), 'armed');
  await h.scheduler.advance(0);
  const readsAfterCommand = h.reads.length;
  await h.scheduler.advance(3000);
  assert.equal(h.reads.length, readsAfterCommand + 1, 'confirmation polls every three seconds');
  assert.equal(h.coordinator.snapshot().targets.get(0), 'armed');
  h.panelState.armedState = 3;
  await h.scheduler.advance(3000);
  assert.equal(h.coordinator.snapshot().targets.size, 0);
  assert.equal(h.coordinator.partition(0).arm.value, 'armed');
  const settled = h.reads.length;
  await h.scheduler.advance(29_999);
  assert.equal(h.reads.length, settled, 'normal cadence resumes after confirmation');
  h.coordinator.close();
  assert.equal(h.scheduler.tasks.size, 0);
});

test('an unconfirmed command expires with a failure instead of claiming success', async () => {
  const h = harness();
  h.coordinator.start();
  await h.scheduler.flush();
  await h.coordinator.arm(0, 'partial');
  await h.scheduler.advance(120_000);
  assert.equal(h.coordinator.snapshot().targets.size, 0);
  assert.equal(h.coordinator.snapshot().failure, 'unconfirmed');
  await h.scheduler.advance(30_000);
  assert.equal(h.coordinator.snapshot().status, 'healthy');
  assert.equal(h.coordinator.snapshot().failure, 'unconfirmed', 'reported until the next command');
  await h.coordinator.arm(0, 'armed');
  assert.equal(h.coordinator.snapshot().failure, undefined);
  h.coordinator.close();
});

test('a disarm may replace a pending arm, but commands in transport are exclusive', async () => {
  const gate = deferred();
  const h = harness({ arm: (_id, target) => (target === 'armed' ? gate.promise : undefined) });
  h.coordinator.start();
  await h.scheduler.flush();
  const arming = h.coordinator.arm(0, 'armed');
  await h.scheduler.flush();
  await assert.rejects(h.coordinator.arm(0, 'disarmed'), { category: 'busy' });
  gate.resolve();
  await arming;
  assert.equal(h.coordinator.snapshot().targets.get(0), 'armed');
  await h.coordinator.arm(0, 'disarmed');
  assert.equal(h.coordinator.snapshot().targets.get(0), 'disarmed');
  assert.deepEqual(h.arms, [
    [0, 'armed'],
    [0, 'disarmed'],
  ]);
  h.coordinator.close();
});

test('commands need fresh partition state, skip no-ops and never replay a failed dispatch', async () => {
  const h = harness({
    arm: async () => {
      throw new CloudError('panel-timeout', 0, true);
    },
  });
  await assert.rejects(h.coordinator.arm(0, 'armed'), { category: 'unavailable' });
  h.coordinator.start();
  await h.scheduler.flush();
  await h.coordinator.arm(0, 'disarmed');
  assert.equal(h.arms.length, 0, 'already disarmed: no traffic');
  await assert.rejects(h.coordinator.arm(0, 'armed'), { category: 'panel-timeout' });
  await assert.rejects(h.coordinator.arm(9, 'armed'), { category: 'unavailable' });
  await h.scheduler.advance(60_000);
  assert.equal(h.arms.length, 1);
  assert.equal(h.coordinator.snapshot().targets.size, 0);
  h.coordinator.close();
});
