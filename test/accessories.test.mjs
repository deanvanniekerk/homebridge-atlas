import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SecuritySystem } from '../dist/homebridge/security-system.js';
import { ZoneSensor } from '../dist/homebridge/zone-sensor.js';
import { SiteCoordinator } from '../dist/site/coordinator.js';
import { decodePanelState } from '../dist/site/panel-model.js';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { panel } from './fake-cloud.mjs';
import { FakeScheduler } from './fake-scheduler.mjs';

const communicationFailure = (error) => error === -70402;

async function setup(t, options = {}) {
  const api = new HomebridgeAPI();
  const scheduler = new FakeScheduler();
  const raw = {
    partition: { id: 0, armedState: 1, alarmState: 0, exitDelayTO: 0, readyState: 2 },
    zones: [
      { zoneID: 1, zoneName: 'Hall PIR', status: 0, trouble: false },
      { zoneID: 2, zoneName: 'Front Door', status: 1, trouble: false },
      { zoneID: 3, zoneName: 'Garden Beam', status: 2, trouble: true },
    ],
    fromControlPanel: true,
    online: true,
  };
  const arms = [];
  const warnings = [];
  const coordinator = new SiteCoordinator(
    {
      read: async () =>
        decodePanelState(
          panel({ partitions: [raw.partition], zones: raw.zones, online: raw.online }).response,
          {
            siteId: 7,
            fromControlPanel: raw.fromControlPanel,
            observedAtMs: scheduler.now(),
          },
        ),
      arm: async (id, target) => {
        arms.push([id, target]);
      },
    },
    { scheduler },
  );
  const make = (name) => new api.platformAccessory(name, api.hap.uuid.generate(name));
  const partitionAccessory = make('Synthetic partition');
  const security = new SecuritySystem(api.hap, partitionAccessory, coordinator, 0, {
    control: options.control ?? true,
    partialArmMode: options.partialArmMode ?? 'stay',
    warn: (message) => warnings.push(message),
  });
  const zones = [
    [1, 'motion'],
    [2, 'contact'],
    [3, 'contact'],
  ].map(([id, kind]) => {
    const accessory = make(`Synthetic zone ${id}`);
    return { accessory, sensor: new ZoneSensor(api.hap, accessory, coordinator, id, kind) };
  });
  t.after(() => {
    security.close();
    for (const zone of zones) zone.sensor.close();
    coordinator.close();
  });
  const C = api.hap.Characteristic;
  const securityChar = (name) =>
    partitionAccessory.getService(api.hap.Service.SecuritySystem).getCharacteristic(C[name]);
  return {
    api,
    C,
    raw,
    arms,
    warnings,
    scheduler,
    coordinator,
    security,
    zones,
    securityChar,
    refresh: async (ms = 30_000) => {
      await scheduler.advance(ms);
      security.update();
      for (const zone of zones) zone.sensor.update();
    },
    start: async () => {
      coordinator.start();
      await scheduler.flush();
      security.update();
      for (const zone of zones) zone.sensor.update();
    },
  };
}

test('security system fails before fresh state, then maps arm and alarm states', async (t) => {
  const h = await setup(t);
  await assert.rejects(
    h.securityChar('SecuritySystemCurrentState').handleGetRequest(),
    communicationFailure,
  );
  await h.start();
  assert.equal(await h.securityChar('SecuritySystemCurrentState').handleGetRequest(), 3);
  assert.equal(await h.securityChar('SecuritySystemTargetState').handleGetRequest(), 3);
  assert.equal(await h.securityChar('StatusFault').handleGetRequest(), 0);
  for (const [armedState, expected] of [
    [2, 0],
    [3, 1],
  ]) {
    h.raw.partition = { ...h.raw.partition, armedState };
    await h.refresh();
    assert.equal(await h.securityChar('SecuritySystemCurrentState').handleGetRequest(), expected);
  }
  h.raw.partition = { ...h.raw.partition, alarmState: 1 };
  h.raw.fromControlPanel = false;
  await h.refresh();
  assert.equal(await h.securityChar('SecuritySystemCurrentState').handleGetRequest(), 4);
  assert.equal(
    await h.securityChar('StatusFault').handleGetRequest(),
    0,
    'cloud-cached state alone is not a fault',
  );
  h.raw.online = false;
  await h.refresh();
  assert.equal(await h.securityChar('StatusFault').handleGetRequest(), 1, 'panel offline');
  assert.deepEqual(h.securityChar('SecuritySystemTargetState').props.validValues, [0, 1, 3]);
});

test('target state writes send commands only when control is enabled', async (t) => {
  const h = await setup(t, { partialArmMode: 'night' });
  await h.start();
  assert.deepEqual(h.securityChar('SecuritySystemTargetState').props.validValues, [1, 2, 3]);
  await h.securityChar('SecuritySystemTargetState').handleSetRequest(2);
  assert.deepEqual(h.arms, [[0, 'partial']]);
  assert.equal(await h.securityChar('SecuritySystemTargetState').handleGetRequest(), 2);
  assert.equal(await h.securityChar('SecuritySystemCurrentState').handleGetRequest(), 3);

  const readOnly = await setup(t, { control: false });
  await readOnly.start();
  const target = readOnly.securityChar('SecuritySystemTargetState');
  assert.ok(!target.props.perms.includes('pw'));
  await assert.rejects(target.handleSetRequest(1), (error) => error === -70404);
  assert.equal(readOnly.arms.length, 0);
});

test('zones map to motion and contact sensors; bypassed zones are inactive', async (t) => {
  const h = await setup(t);
  await h.start();
  const [motion, contact, bypassed] = h.zones.map((zone) => zone.accessory);
  const get = (accessory, service, name) =>
    accessory
      .getService(h.api.hap.Service[service])
      .getCharacteristic(h.C[name])
      .handleGetRequest();
  assert.equal(await get(motion, 'MotionSensor', 'MotionDetected'), false);
  assert.equal(await get(motion, 'MotionSensor', 'StatusActive'), true);
  assert.equal(await get(contact, 'ContactSensor', 'ContactSensorState'), 1);
  assert.equal(await get(bypassed, 'ContactSensor', 'ContactSensorState'), 0);
  assert.equal(await get(bypassed, 'ContactSensor', 'StatusActive'), false);
  h.raw.zones = [
    { zoneID: 1, status: 1 },
    { zoneID: 2, status: 0 },
    { zoneID: 3, status: 9 },
  ];
  await h.refresh();
  assert.equal(await get(motion, 'MotionSensor', 'MotionDetected'), true);
  assert.equal(await get(contact, 'ContactSensor', 'ContactSensorState'), 0);
  await assert.rejects(get(bypassed, 'ContactSensor', 'ContactSensorState'), communicationFailure);
  const retyped = new ZoneSensor(h.api.hap, contact, h.coordinator, 2, 'motion');
  t.after(() => retyped.close());
  assert.equal(contact.getService(h.api.hap.Service.ContactSensor), undefined);
  assert.ok(contact.getService(h.api.hap.Service.MotionSensor));
});
