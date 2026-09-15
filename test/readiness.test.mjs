import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { SiteCoordinator } from '../dist/coordinator.js';
import { decodePanelState } from '../dist/panel-model.js';
import { SecuritySystem } from '../dist/security-system.js';
import { ZoneSensor } from '../dist/zone-sensor.js';
import { deferred, FakeScheduler } from './fake-scheduler.mjs';
import { panel } from './fake-cloud.mjs';

// Synthetic contract for fields observed on the owner's panel: readyState 0 with a door open,
// isOnline true, and a boolean zone trouble flag on one faulted beam.
function harness() {
  const scheduler = new FakeScheduler();
  const raw = {
    partition: { id: 0, armedState: 1, alarmState: 0, exitDelayTO: 0, readyState: 0 },
    zones: [
      { zoneID: 1, zoneName: 'Front Door', status: 1, trouble: false },
      { zoneID: 2, zoneName: 'Beam Front', status: 0, trouble: true },
    ],
    online: true,
  };
  const arms = [];
  const streams = [];
  const coordinator = new SiteCoordinator(
    {
      read: async () =>
        decodePanelState(
          panel({ partitions: [raw.partition], zones: raw.zones, online: raw.online }).response,
          { siteId: 7, fromControlPanel: true, observedAtMs: scheduler.now() },
        ),
      arm: async (id, target) => {
        arms.push([id, target]);
      },
      watch: (_signal, handlers) => {
        const stream = { ...deferred(), handlers };
        streams.push(stream);
        handlers.onOpen();
        return stream.promise;
      },
    },
    { scheduler, push: true },
  );
  return { scheduler, raw, arms, streams, coordinator };
}

test('arming is refused locally while the partition is not ready; disarming is never blocked', async () => {
  const h = harness();
  h.coordinator.start();
  await h.scheduler.advance(1000);
  assert.equal(h.coordinator.partition(0).ready.value, false);
  for (const target of ['armed', 'partial'])
    await assert.rejects(h.coordinator.arm(0, target), { category: 'not-ready' });
  assert.deepEqual(h.arms, [], 'nothing was sent to the panel');

  h.raw.partition = { ...h.raw.partition, armedState: 3 };
  h.streams[0].handlers.onUpdate({
    offline: false,
    statusUpdatedAtMs: Date.parse('2026-09-15T18:00:00Z'),
    eventUpdatedAtMs: undefined,
  });
  await h.scheduler.advance(1000);
  await h.coordinator.arm(0, 'disarmed');
  assert.deepEqual(h.arms, [[0, 'disarmed']]);
  h.coordinator.close();
});

test('an unknown readiness value does not block commands', async () => {
  const h = harness();
  h.raw.partition = { ...h.raw.partition, readyState: 7 };
  h.coordinator.start();
  await h.scheduler.advance(1000);
  assert.equal(h.coordinator.partition(0).ready.available, false);
  await h.coordinator.arm(0, 'partial');
  assert.deepEqual(h.arms, [[0, 'partial']]);
  h.coordinator.close();
});

test('offline state follows the most recent of the panel read and the pushed IsOffline', async () => {
  const h = harness();
  h.coordinator.start();
  await h.scheduler.advance(1000);
  assert.equal(h.coordinator.snapshot().offline, false);
  h.streams[0].handlers.onUpdate({
    offline: true,
    statusUpdatedAtMs: undefined,
    eventUpdatedAtMs: undefined,
  });
  h.raw.online = false;
  await h.scheduler.flush();
  assert.equal(h.coordinator.snapshot().offline, true, 'pushed offline applies immediately');
  await assert.rejects(h.coordinator.arm(0, 'disarmed'), { category: 'offline' });
  await h.scheduler.advance(1000);
  assert.equal(h.coordinator.snapshot().offline, true);
  h.raw.online = true;
  await h.scheduler.advance(300_000);
  assert.equal(h.coordinator.snapshot().offline, false, 'a newer online panel read wins');
  assert.deepEqual(h.arms, []);
  h.coordinator.close();
});

test('HomeKit shows zone faults and panel offline, and refuses arming when not ready', async (t) => {
  const h = harness();
  const api = new HomebridgeAPI();
  const make = (name) => new api.platformAccessory(name, api.hap.uuid.generate(name));
  const warnings = [];
  const partition = make('Synthetic partition');
  const security = new SecuritySystem(api.hap, partition, h.coordinator, 0, {
    control: true,
    partialArmMode: 'stay',
    warn: (message) => warnings.push(message),
  });
  const door = make('Synthetic door');
  const beam = make('Synthetic beam');
  const sensors = [
    new ZoneSensor(api.hap, door, h.coordinator, 1, 'contact'),
    new ZoneSensor(api.hap, beam, h.coordinator, 2, 'motion'),
  ];
  t.after(() => {
    security.close();
    for (const sensor of sensors) sensor.close();
    h.coordinator.close();
  });
  const C = api.hap.Characteristic;
  const fault = (accessory, service) =>
    accessory
      .getService(api.hap.Service[service])
      .getCharacteristic(C.StatusFault)
      .handleGetRequest();
  h.coordinator.start();
  await h.scheduler.advance(1000);
  assert.equal(await fault(door, 'ContactSensor'), 0);
  assert.equal(await fault(beam, 'MotionSensor'), 1, 'zone trouble is a fault');
  assert.equal(await fault(partition, 'SecuritySystem'), 0);

  const target = partition
    .getService(api.hap.Service.SecuritySystem)
    .getCharacteristic(C.SecuritySystemTargetState);
  await assert.rejects(
    target.handleSetRequest(C.SecuritySystemTargetState.AWAY_ARM),
    (error) => error === api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
  );
  assert.deepEqual(h.arms, []);
  assert.match(warnings[0], /not ready/);
  assert.equal(await target.handleGetRequest(), C.SecuritySystemTargetState.DISARM);

  h.raw.online = false;
  h.streams[0].handlers.onUpdate({
    offline: true,
    statusUpdatedAtMs: undefined,
    eventUpdatedAtMs: undefined,
  });
  await h.scheduler.advance(1000);
  assert.equal(await fault(partition, 'SecuritySystem'), 1, 'panel offline');
  assert.equal(await fault(door, 'ContactSensor'), 1, 'offline faults every zone');
});
