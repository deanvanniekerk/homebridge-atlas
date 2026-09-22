import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { onTestFinished, test } from 'vitest';
import { RiscoClient } from './cloud-client.js';
import {
  credentials,
  failure,
  reply,
  riscoRoutes,
  serverFor,
  sessionId,
  siteId,
  success,
} from './fake-cloud.test-support.js';

const routes = (calls) => calls.map((call) => call.route);

test('concurrent reads share one three-stage login and send the mobile API contract', async () => {
  const server = await serverFor(riscoRoutes());
  const client = new RiscoClient(credentials, { origin: server.origin });
  onTestFinished(() => client.close());
  const results = await Promise.all(Array.from({ length: 8 }, () => client.state()));
  assert.equal(results[0].siteId, siteId);
  assert.equal(results[0].fromControlPanel, true);
  assert.deepEqual(routes(server.calls.slice(0, 3)), ['login', 'sites', 'siteLogin']);
  assert.equal(server.calls.filter((call) => call.route === 'login').length, 1);
  assert.deepEqual(server.calls[0].body, {
    userName: credentials.username,
    password: credentials.password,
  });
  assert.equal(server.calls[0].authorization, undefined);
  assert.equal(server.calls[1].authorization, 'Bearer synthetic-token');
  assert.equal(server.calls[2].path, `/webapi/api/wuws/site/${siteId}/Login`);
  assert.deepEqual(server.calls[2].body, { languageId: 'en', pinCode: credentials.pin });
  assert.deepEqual(server.calls[3].body, { fromControlPanel: true, sessionToken: sessionId });
});

test('a panel timeout falls back once to cloud-cached state', async () => {
  const server = await serverFor(
    riscoRoutes({
      state: (call, res) =>
        call.body.fromControlPanel ? reply(res, failure({ result: 72 })) : riscoRoutes()(call, res),
    }),
  );
  const client = new RiscoClient(credentials, { origin: server.origin });
  onTestFinished(() => client.close());
  const result = await client.state();
  assert.equal(result.fromControlPanel, false);
  assert.deepEqual(
    server.calls.filter((call) => call.route === 'state').map((call) => call.body.fromControlPanel),
    [true, false],
  );
});

test('a live panel read that exceeds the request deadline falls back to cloud-cached state', async () => {
  const server = await serverFor(
    riscoRoutes({
      state: (call, res) => {
        // A slow panel never answers the live read within the client's request deadline.
        if (!call.body.fromControlPanel) riscoRoutes()(call, res);
      },
    }),
  );
  const client = new RiscoClient(credentials, { origin: server.origin, requestTimeoutMs: 150 });
  onTestFinished(() => client.close());
  const result = await client.state();
  assert.equal(result.fromControlPanel, false);
  assert.deepEqual(
    server.calls.filter((call) => call.route === 'state').map((call) => call.body.fromControlPanel),
    [true, false],
  );
});

test('session expiry renews the whole login once and replays the read', async () => {
  let logins = 0;
  const server = await serverFor(
    riscoRoutes({
      login: (_call, res) => {
        logins += 1;
        reply(res, success({ accessToken: `token-${logins}` }));
      },
      state: (call, res) =>
        call.authorization === 'Bearer token-1'
          ? reply(res, { status: 401, errorText: 'synthetic', response: null })
          : riscoRoutes()(call, res),
    }),
  );
  const client = new RiscoClient(credentials, { origin: server.origin });
  onTestFinished(() => client.close());
  await client.state();
  assert.equal(logins, 2);
  assert.deepEqual(routes(server.calls), [
    'login',
    'sites',
    'siteLogin',
    'state',
    'login',
    'sites',
    'siteLogin',
    'state',
  ]);
});

test('rejected credentials, PIN and site selection pause traffic until reconfigured', async () => {
  const scenarios = [
    ['invalid-credentials', { login: (_c, res) => reply(res, { status: 401, errorText: 'x' }) }],
    ['invalid-pin', { siteLogin: (_c, res) => reply(res, failure({ result: 5 })) }],
    ['invalid-pin', { siteLogin: (_c, res) => reply(res, { status: 401, response: null }) }],
    [
      'site-selection',
      {
        sites: (_c, res) =>
          reply(
            res,
            success([
              { id: 1, name: 'A' },
              { id: 2, name: 'B' },
            ]),
          ),
      },
    ],
  ];
  for (const [category, overrides] of scenarios) {
    const server = await serverFor(riscoRoutes(overrides));
    const client = new RiscoClient(credentials, { origin: server.origin });
    onTestFinished(() => client.close());
    await assert.rejects(client.state(), { category });
    const count = server.calls.length;
    await assert.rejects(client.state(), { category });
    assert.equal(server.calls.length, count, `${category} must not retry`);
  }
});

test('an explicit site id selects among several sites', async () => {
  const server = await serverFor(
    riscoRoutes({
      sites: (_c, res) =>
        reply(
          res,
          success([
            { id: 1, name: 'A' },
            { id: siteId, name: 'B' },
          ]),
        ),
    }),
  );
  const client = new RiscoClient({ ...credentials, siteId }, { origin: server.origin });
  onTestFinished(() => client.close());
  assert.equal((await client.state()).siteId, siteId);
});

test('arm commands encode armedState and are never replayed', async () => {
  let armCalls = 0;
  const server = await serverFor(
    riscoRoutes({
      arm: (_call, res) => {
        armCalls += 1;
        reply(res, armCalls === 1 ? failure({ result: 72 }) : success({}));
      },
    }),
  );
  const client = new RiscoClient(credentials, { origin: server.origin });
  onTestFinished(() => client.close());
  await assert.rejects(client.arm(0, 'armed'), {
    category: 'panel-timeout',
    deliveryUncertain: true,
  });
  assert.equal(armCalls, 1);
  const armBody = server.calls.find((call) => call.route === 'arm').body;
  assert.deepEqual(armBody, {
    partitions: [{ id: 0, armedState: 3 }],
    fromControlPanel: true,
    sessionToken: sessionId,
  });
  await assert.rejects(client.arm(-1, 'armed'), { category: 'invalid-request' });
  await assert.rejects(client.arm(0, 'toggle'), { category: 'invalid-request' });
});

test('malformed envelopes and HTTP failures map to fixed categories without vendor text', async () => {
  const cases = [
    [(res) => reply(res, { secret: credentials.password }), 'invalid-response'],
    [(res) => reply(res, { status: 200, response: null, result: 'x' }), 'invalid-response'],
    [(res) => reply(res, { status: 403, response: null }), 'permission-denied'],
    [(res) => reply(res, failure({ result: 9 })), 'vendor-rejected', 9],
  ];
  for (const [respond, category, vendorResult] of cases) {
    const server = await serverFor(riscoRoutes({ state: (_c, res) => respond(res) }));
    const client = new RiscoClient(credentials, { origin: server.origin });
    onTestFinished(() => client.close());
    const error = await client.state().catch((caught) => caught);
    assert.equal(error.category, category);
    assert.equal(error.vendorResult, vendorResult);
    assert.doesNotMatch(inspect(error), /synthetic-password|synthetic-token|synthetic-session/);
  }
});

test('configuration is validated before any traffic', () => {
  for (const bad of [
    { ...credentials, pin: '12' },
    { ...credentials, pin: '12ab' },
    { ...credentials, username: ' ' },
    { ...credentials, siteId: -1 },
  ])
    assert.throws(() => new RiscoClient(bad), { category: 'invalid-request' });
  assert.throws(() => new RiscoClient(credentials, { origin: 'https://example.com' }), {
    category: 'invalid-request',
  });
});
