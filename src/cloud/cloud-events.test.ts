import assert from 'node:assert/strict';
import { onTestFinished, test } from 'vitest';
import { AtlasGateway } from '../site/gateway.js';
import { RiscoClient } from './cloud-client.js';
import { decodeRuntimeUpdate, EventStreamParser } from './cloud-events.js';
import {
  credentials,
  panel,
  reply,
  riscoRoutes,
  serverFor,
  sessionId,
  siteId,
  success,
} from './fake-cloud.test-support.js';

// Synthetic stream framing and payloads modelled on the public RISCO Cloud contract.
const update = (status, event = status) =>
  `event: runtimeUpdate\ndata: ${JSON.stringify({
    IsOffline: false,
    LastStatusUpdate: status,
    LastEventUpdated: event,
  })}\n\n`;

test('parses server-sent events across chunk boundaries, CRLF, comments and multi-line data', () => {
  const parser = new EventStreamParser();
  assert.deepEqual(parser.push(': keep-alive\r\n\r\nevent: runtime'), []);
  assert.deepEqual(parser.push('Update\r\ndata: {"a":\r\ndata: 1}\r\n'), []);
  assert.deepEqual(parser.push('\r\ndata: plain\n\nid: 7\nretry: 10\n\n'), [
    { event: 'runtimeUpdate', data: '{"a":\n1}' },
    { event: 'message', data: 'plain' },
  ]);
  assert.throws(() => new EventStreamParser().push(`data: ${'x'.repeat(70_000)}\n`), {
    category: 'invalid-response',
  });
});

test('decodes runtime updates, treating zone-less vendor timestamps as UTC', () => {
  assert.deepEqual(
    decodeRuntimeUpdate(
      JSON.stringify({
        IsOffline: true,
        LastStatusUpdate: '2026-09-15T17:00:00.5',
        LastEventUpdated: '2026-09-15T19:00:00+02:00',
      }),
    ),
    {
      offline: true,
      statusUpdatedAtMs: Date.parse('2026-09-15T17:00:00.5Z'),
      eventUpdatedAtMs: Date.parse('2026-09-15T17:00:00Z'),
    },
  );
  assert.deepEqual(decodeRuntimeUpdate('{"LastStatusUpdate":"soon"}'), {
    offline: undefined,
    statusUpdatedAtMs: undefined,
    eventUpdatedAtMs: undefined,
  });
  assert.throws(() => decodeRuntimeUpdate('not json'), { category: 'invalid-response' });
});

test('the client opens the site stream with its session and delivers messages until the end', async () => {
  const server = await serverFor(
    riscoRoutes({
      events: (_call, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(update('2026-09-15T17:00:00Z').slice(0, 20));
        setTimeout(() => res.end(update('2026-09-15T17:00:00Z').slice(20)), 20);
      },
    }),
  );
  const client = new RiscoClient(credentials, { origin: server.origin });
  onTestFinished(() => client.close());
  const seen = [];
  await client.events({
    onOpen: () => seen.push('open'),
    onMessage: (message) => seen.push(message.event),
  });
  assert.deepEqual(seen, ['open', 'runtimeUpdate']);
  const call = server.calls.find((item) => item.route === 'events');
  assert.equal(call.method, 'GET');
  assert.equal(call.path, `/webapi/api/wuws/site/${siteId}/ControlPanel/sse/connect`);
  assert.equal(call.authorization, 'Bearer synthetic-token');
  assert.equal(call.sessionToken, sessionId);
  assert.deepEqual(call.query, { sessionToken: sessionId });
});

test('stream failures map to categories; expiry renews the session for the next attempt', async () => {
  let logins = 0;
  let streams = 0;
  const server = await serverFor(
    riscoRoutes({
      login: (_call, res) => {
        logins += 1;
        reply(res, success({ accessToken: `token-${logins}` }));
      },
      events: (_call, res) => {
        streams += 1;
        if (streams === 1) {
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Status Code: 401; Unauthorized');
        } else if (streams === 2) reply(res, success({}));
        else res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders();
      },
    }),
  );
  const client = new RiscoClient(credentials, { origin: server.origin });
  onTestFinished(() => client.close());
  const handlers = { onOpen: () => {}, onMessage: () => {} };
  await assert.rejects(client.events(handlers), { category: 'session-expired' });
  await assert.rejects(client.events(handlers), { category: 'invalid-response' });
  assert.equal(logins, 2, 'the expired session was replaced');
  await assert.rejects(client.events(handlers, { idleTimeoutMs: 100 }), { category: 'timeout' });
  const abort = new AbortController();
  const cancelled = client.events(handlers, { signal: abort.signal });
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(cancelled, { category: 'cancelled' });
});

test('the gateway reads cached state after a push and asks the panel only when the cache is older', async () => {
  const older = '2026-09-15T17:00:00Z';
  const newer = '2026-09-15T17:00:05Z';
  let cached = older;
  const withStatus = (lastStatusUpdate) => {
    const value = panel().response;
    value.state.lastStatusUpdate = lastStatusUpdate;
    return success(value);
  };
  const server = await serverFor(
    riscoRoutes({
      state: (call, res) => reply(res, withStatus(call.body.fromControlPanel ? newer : cached)),
    }),
  );
  const gateway = new AtlasGateway(new RiscoClient(credentials, { origin: server.origin }));
  onTestFinished(() => gateway.close());
  const signal = new AbortController().signal;
  const stateCalls = () =>
    server.calls.filter((call) => call.route === 'state').map((call) => call.body.fromControlPanel);

  const escalated = await gateway.read(signal, { notBefore: Date.parse(newer) });
  assert.equal(escalated.source, 'panel');
  assert.deepEqual(stateCalls(), [false, true]);
  cached = newer;
  const fromCache = await gateway.read(signal, { notBefore: Date.parse(newer) });
  assert.equal(fromCache.source, 'cloud');
  assert.equal(fromCache.statusUpdatedAtMs, Date.parse(newer));
  assert.equal(fromCache.evidence.statusTimestamp, 'iso-utc');
  assert.deepEqual(stateCalls(), [false, true, false]);
  assert.equal((await gateway.read(signal)).source, 'panel');
  assert.deepEqual(gateway.readStats().escalations, 1);
});

test('the gateway decodes runtime updates from the stream and counts event names', async () => {
  const server = await serverFor(
    riscoRoutes({
      events: (_call, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          `${update('2026-09-15T17:00:00Z')}event: ping\ndata: {}\n\nevent: runtimeUpdate\ndata: ?\n\n`,
        );
      },
    }),
  );
  const gateway = new AtlasGateway(new RiscoClient(credentials, { origin: server.origin }));
  onTestFinished(() => gateway.close());
  const updates = [];
  await gateway.watch(new AbortController().signal, {
    onOpen: () => {},
    onUpdate: (value) => updates.push(value),
  });
  assert.deepEqual(updates, [
    {
      offline: false,
      statusUpdatedAtMs: Date.parse('2026-09-15T17:00:00Z'),
      eventUpdatedAtMs: Date.parse('2026-09-15T17:00:00Z'),
    },
    { offline: undefined, statusUpdatedAtMs: undefined, eventUpdatedAtMs: undefined },
  ]);
  assert.deepEqual(gateway.eventStats(), { runtimeUpdate: 2, ping: 1 });
});
