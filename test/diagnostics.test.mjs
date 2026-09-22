import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RiscoClient } from '../dist/cloud/cloud-client.js';
import { shapeOf } from '../dist/cloud/shape.js';
import { Diagnostics } from '../dist/site/diagnostics.js';
import { AtlasGateway } from '../dist/site/gateway.js';
import { decodePanelState } from '../dist/site/panel-model.js';
import { credentials, panel, reply, riscoRoutes, serverFor, success } from './fake-cloud.mjs';

const secretName = 'Synthetic Private Bedroom PIR';

function snapshot(overrides = {}) {
  const raw = panel({
    zones: [
      { zoneID: 1, zoneName: secretName, zoneType: 3, status: 1, trouble: 0, extra: 'private' },
      { zoneID: 2, zoneName: 'Door', zoneType: 1, status: 0 },
    ],
  }).response;
  return {
    status: 'healthy',
    panel: decodePanelState(raw, { siteId: 7, fromControlPanel: true, observedAtMs: 1000 }),
    lastSuccessMs: 1000,
    failure: undefined,
    failureCode: undefined,
    retryAtMs: 0,
    targets: new Map(),
    stream: {
      mode: 'push',
      connected: true,
      connects: 1,
      disconnects: 0,
      updates: 2,
      lastUpdateMs: 3000,
      lastUpdateLatencyMs: 850,
      lastFailure: undefined,
      offline: false,
      lastConnectionMs: 358_000,
      lastDropSilenceMs: 120_000,
    },
    ...overrides,
  };
}

test('debug reports are sanitized, bounded to one per five minutes and off by default', () => {
  let now = 5000;
  const lines = [];
  const options = { now: () => now, pluginVersion: '0.1.0-alpha.0', homebridgeVersion: '2.4.0' };
  new Diagnostics((line) => lines.push(line), options).observe(snapshot());
  assert.equal(lines.length, 0);
  const diagnostics = new Diagnostics((line) => lines.push(line), {
    ...options,
    debug: true,
    readStats: () => ({ panel: 3, cloud: 1, lastDurationMs: 1200 }),
  });
  diagnostics.observe(snapshot());
  diagnostics.observe(snapshot());
  assert.equal(lines.length, 1);
  now += 300_000;
  diagnostics.observe(snapshot());
  assert.equal(lines.length, 2);
  const report = JSON.parse(lines[0].replace('Diagnostic report: ', ''));
  assert.equal(report.runtime.plugin, '0.1.0-alpha.0');
  assert.equal(report.site.lastSuccessAgeMs, 4000);
  assert.equal(report.site.failureCode, null);
  assert.deepEqual(report.site.reads, { panel: 3, cloud: 1, lastDurationMs: 1200 });
  assert.deepEqual(report.stream, {
    mode: 'push',
    connected: true,
    connects: 1,
    disconnects: 0,
    updates: 2,
    lastUpdateAgeMs: 2000,
    lastUpdateLatencyMs: 850,
    lastFailure: null,
    offline: false,
    lastConnectionMs: 358_000,
    lastDropSilenceMs: 120_000,
    events: null,
  });
  assert.deepEqual(report.panel.partitions, [
    { id: 0, arm: 'disarmed', alarm: 'false', exitDelaySeconds: '0', ready: 'false' },
  ]);
  assert.equal(report.panel.online, 'true');
  assert.equal(report.site.offline, null);
  assert.deepEqual(report.panel.zones, {
    count: 2,
    conditions: { triggered: 1, normal: 1 },
    faults: 0,
  });
  assert.deepEqual(report.panel.evidence.zoneStatuses, { 1: 1, 0: 1 });
  assert.deepEqual(report.panel.evidence.zoneTypes, { 3: 1, 1: 1 });
  assert.deepEqual(report.panel.evidence.zoneTroubles, { 0: 1, undefined: 1 });
  assert.deepEqual(report.panel.evidence.online, { true: 1 });
  assert.deepEqual(report.panel.evidence.zoneFields, [
    'extra',
    'status',
    'trouble',
    'zoneID',
    'zoneName',
    'zoneType',
  ]);
  assert.doesNotMatch(lines.join('\n'), /Private|Door|private/);
});

test('value-free shapes describe unrecognized replies', () => {
  assert.deepEqual(
    shapeOf({
      state: { items: [{ name: secretName, n: 1 }], ok: true, 'bad key!': 'x' },
      nothing: null,
    }),
    {
      nothing: 'null',
      state: {
        '?': 'field',
        items: { array: 1, first: { n: 'number', name: 'string' } },
        ok: 'boolean',
      },
    },
  );
});

test('protocol failures keep the rejected reply shape for debug reports', async (t) => {
  const server = await serverFor(
    t,
    riscoRoutes({
      login: (_call, res) => reply(res, success({ token: 'synthetic-token' })),
    }),
  );
  const client = new RiscoClient(credentials, { origin: server.origin });
  const gateway = new AtlasGateway(client);
  t.after(() => gateway.close());
  await assert.rejects(gateway.read(new AbortController().signal), {
    category: 'invalid-response',
  });
  assert.deepEqual(gateway.rejectedShape(), { stage: 'login', shape: { token: 'string' } });

  const stateServer = await serverFor(
    t,
    riscoRoutes({ state: (_call, res) => reply(res, success({ status: { zones: [] } })) }),
  );
  const stateGateway = new AtlasGateway(
    new RiscoClient(credentials, { origin: stateServer.origin }),
  );
  t.after(() => stateGateway.close());
  await assert.rejects(stateGateway.read(new AbortController().signal), {
    category: 'invalid-response',
  });
  assert.deepEqual(stateGateway.rejectedShape(), {
    stage: 'state',
    shape: { status: { zones: { array: 0 } } },
  });
  const lines = [];
  new Diagnostics((line) => lines.push(line), {
    pluginVersion: '0.1.0-alpha.0',
    homebridgeVersion: '2.4.0',
    debug: true,
    rejectedShape: () => stateGateway.rejectedShape(),
  }).observe(snapshot({ status: 'protocol-error', failure: 'invalid-response', panel: undefined }));
  assert.match(lines[0], /"rejectedShape":\{"stage":"state"/);
});
