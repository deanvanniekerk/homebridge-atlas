import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverZones } from '../dist/setup.js';
import {
  credentials,
  panel,
  reply,
  riscoRoutes,
  serverFor,
  siteId,
  success,
} from './fake-cloud.mjs';

test('settings discovery returns zones with suggested sensor types and live conditions', async (t) => {
  const server = await serverFor(t, riscoRoutes());
  const result = await discoverZones(credentials, { origin: server.origin });
  assert.deepEqual(result, {
    kind: 'zones',
    siteId,
    partitions: 1,
    zones: [
      { id: 0, name: 'Hall PIR', suggested: 'motion', condition: 'normal' },
      { id: 1, name: 'Front Door', suggested: 'contact', condition: 'triggered' },
      { id: 4, name: 'Garden Beam', suggested: 'motion', condition: 'bypassed' },
    ],
  });
  assert.ok(server.calls.every((call) => call.route !== 'arm'));
});

test('settings discovery asks for a site when the account has several', async (t) => {
  const sites = [
    { id: 1, name: 'Home' },
    { id: 2, name: 'Office' },
  ];
  const server = await serverFor(
    t,
    riscoRoutes({
      sites: (_call, res) => reply(res, success(sites)),
      state: (call, res) =>
        call.path.includes('/site/2/') ? reply(res, panel({ zones: [] })) : reply(res, panel()),
    }),
  );
  assert.deepEqual(await discoverZones(credentials, { origin: server.origin }), {
    kind: 'site-required',
    sites,
  });
  assert.ok(
    server.calls.every((call) => call.route !== 'siteLogin'),
    'no PIN sent before choosing',
  );
  const chosen = await discoverZones({ ...credentials, siteId: '2' }, { origin: server.origin });
  assert.equal(chosen.kind, 'zones');
  assert.equal(chosen.siteId, 2);
});

test('settings discovery surfaces fixed failure categories', async (t) => {
  const server = await serverFor(
    t,
    riscoRoutes({ siteLogin: (_call, res) => reply(res, { status: 401, response: null }) }),
  );
  await assert.rejects(discoverZones(credentials, { origin: server.origin }), {
    category: 'invalid-pin',
  });
  await assert.rejects(discoverZones({ ...credentials, pin: '12' }), {
    category: 'invalid-request',
  });
  await assert.rejects(discoverZones(null), { category: 'invalid-request' });
});
