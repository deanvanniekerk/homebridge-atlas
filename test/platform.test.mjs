import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AtlasPlatform } from '../dist/homebridge/platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../dist/settings.js';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { credentials, panel, reply, riscoRoutes, serverFor, siteId } from './fake-cloud.mjs';
import { redirectCloud } from './redirect-cloud.mjs';

async function waitUntil(condition) {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Platform condition timed out');
    await delay(10);
  }
}

async function host(t, extraConfig = {}, cached = [], zones) {
  const server = await serverFor(
    t,
    riscoRoutes(zones ? { state: (_call, res) => reply(res, panel({ zones })) } : {}),
  );
  const restoreTransport = redirectCloud(server.origin);
  const api = new HomebridgeAPI();
  const registered = [];
  const removed = [];
  const logs = [];
  api.on('registerPlatformAccessories', (accessories) => registered.push(...accessories));
  api.on('unregisterPlatformAccessories', (accessories) => removed.push(...accessories));
  const log = Object.fromEntries(
    ['info', 'warn', 'error', 'debug'].map((key) => [key, (line) => logs.push(line)]),
  );
  const platform = new AtlasPlatform(
    log,
    { platform: PLATFORM_NAME, ...credentials, ...extraConfig },
    api,
  );
  const restored = cached.map((item) => {
    const accessory = api.platformAccessory.deserialize(item);
    platform.configureAccessory(accessory);
    return accessory;
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    api.emit('shutdown');
    restoreTransport();
  };
  t.after(stop);
  return {
    api,
    stop,
    registered,
    removed,
    logs,
    restored,
    calls: server.calls,
    launch: async () => {
      api.emit('didFinishLaunching');
      await waitUntil(() => server.calls.some((call) => call.route === 'state'));
    },
  };
}

const uuid = (api, kind, id) =>
  api.hap.uuid.generate(`${PLUGIN_NAME}:site:${siteId}:${kind}:${id}`);

test('registers one security system and one sensor per zone with stable identities', async (t) => {
  const cold = await host(t, { zones: [{ id: 4, type: 'hidden' }] });
  await cold.launch();
  await waitUntil(() => cold.registered.length === 3);
  const [partition, hall, door] = cold.registered;
  assert.equal(partition.UUID, uuid(cold.api, 'partition', 0));
  assert.equal(partition.displayName, 'Atlas');
  assert.ok(partition.getService(cold.api.hap.Service.SecuritySystem));
  assert.ok(hall.getService(cold.api.hap.Service.MotionSensor));
  assert.ok(door.getService(cold.api.hap.Service.ContactSensor));
  assert.equal(partition._associatedPlugin, PLUGIN_NAME);
  const current = partition
    .getService(cold.api.hap.Service.SecuritySystem)
    .getCharacteristic(cold.api.hap.Characteristic.SecuritySystemCurrentState);
  await waitUntil(() => current.value === 3);
  assert.deepEqual(cold.api.platformAccessory.serialize(door).context, {
    siteId,
    kind: 'zone',
    id: 1,
    sensor: 'contact',
  });
  assert.ok(cold.logs.some((line) => line.includes('arming and disarming disabled')));
  await waitUntil(() => cold.logs.includes('Push updates connected.'));
  assert.ok(cold.calls.some((call) => call.route === 'events'));
  assert.ok(cold.calls.every((call) => call.route !== 'arm'));
  assert.ok(!cold.logs.join('\n').includes(credentials.password));
  cold.stop();

  const warm = await host(
    t,
    { zones: [{ id: 1, type: 'motion' }] },
    cold.registered.map((item) => cold.api.platformAccessory.serialize(item)),
  );
  assert.equal(warm.restored.length, 3);
  await assert.rejects(
    warm.restored[0]
      .getService(warm.api.hap.Service.SecuritySystem)
      .getCharacteristic(warm.api.hap.Characteristic.SecuritySystemCurrentState)
      .handleGetRequest(),
    (error) => error === -70402,
    'cached values are not presented as fresh state',
  );
  await warm.launch();
  await waitUntil(() => warm.registered.length === 1);
  assert.equal(warm.registered[0].UUID, uuid(warm.api, 'zone', 4), 'unhidden zone is added');
  assert.equal(warm.removed.length, 0);
  const retyped = warm.restored[2];
  await waitUntil(() => retyped.getService(warm.api.hap.Service.MotionSensor) !== undefined);
  assert.equal(retyped.getService(warm.api.hap.Service.ContactSensor), undefined);
});

test('hiding zones removes only their accessories; invalid config sends no traffic', async (t) => {
  const source = await host(t);
  await source.launch();
  await waitUntil(() => source.registered.length === 4);
  source.stop();
  const cached = source.registered.map((item) => source.api.platformAccessory.serialize(item));
  const hidden = await host(t, { includeZones: false }, cached);
  await hidden.launch();
  await waitUntil(() => hidden.removed.length === 3);
  assert.deepEqual(
    hidden.removed.map((item) => item.context.kind),
    ['zone', 'zone', 'zone'],
  );
  hidden.stop();

  const invalid = await host(t, { pin: 'abc' });
  invalid.api.emit('didFinishLaunching');
  await delay(50);
  assert.equal(invalid.calls.length, 0);
  assert.ok(invalid.logs.some((line) => line.includes('Configuration rejected')));
  assert.ok(!invalid.logs.join('\n').includes('abc'));
});

test('an unconfigured platform removes stale accessories without starting monitoring', async (t) => {
  const source = await host(t);
  await source.launch();
  await waitUntil(() => source.registered.length === 4);
  source.stop();
  const cached = source.registered.map((item) => source.api.platformAccessory.serialize(item));

  const api = new HomebridgeAPI();
  const removed = [];
  const logs = { info: [], warn: [], error: [] };
  api.on('registerPlatformAccessories', () => assert.fail('registered an accessory'));
  api.on('unregisterPlatformAccessories', (accessories) => removed.push(...accessories));
  const log = {
    info: (line) => logs.info.push(line),
    warn: (line) => logs.warn.push(line),
    error: (line) => logs.error.push(line),
    debug: () => {},
  };
  const server = await serverFor(t, () => assert.fail('network traffic while unconfigured'));
  const restore = redirectCloud(server.origin);
  t.after(restore);
  const platform = new AtlasPlatform(log, { platform: PLATFORM_NAME, name: 'Atlas' }, api);
  for (const item of cached) platform.configureAccessory(api.platformAccessory.deserialize(item));
  api.emit('didFinishLaunching');
  await delay(50);
  t.after(() => api.emit('shutdown'));
  assert.equal(removed.length, 4);
  assert.deepEqual(logs.info, ['Atlas is not configured. Open the plugin settings to sign in.']);
  assert.deepEqual(logs.warn, []);
  assert.deepEqual(logs.error, []);
  assert.equal(server.calls.length, 0);
});
