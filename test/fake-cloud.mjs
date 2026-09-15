import { createServer } from 'node:http';
import { once } from 'node:events';

// All responses and identities in this file are synthetic, not captured traffic. The envelope
// and field names follow the RISCO Cloud mobile API as used by public integrations.
export const success = (response) => ({
  status: 200,
  errorText: null,
  result: 0,
  response,
});
export const failure = (fields) => ({
  status: 200,
  errorText: 'synthetic',
  response: null,
  ...fields,
});
export const credentials = {
  username: 'synthetic@example.invalid',
  password: 'synthetic-password',
  pin: '123456',
};
export const siteId = 4242;
export const sessionId = 'synthetic-session';

export function panel({ partitions, zones } = {}) {
  return success({
    state: {
      status: {
        partitions: partitions ?? [{ id: 0, armedState: 1, alarmState: 0, exitDelayTO: 0 }],
        zones: zones ?? [
          { zoneID: 0, zoneName: 'Hall PIR', zoneType: 3, status: 0 },
          { zoneID: 1, zoneName: 'Front Door', zoneType: 1, status: 1 },
          { zoneID: 4, zoneName: 'Garden Beam', zoneType: 3, status: 2 },
        ],
      },
    },
  });
}

/** Default happy-path RISCO cloud; `overrides[name]` replaces a route's handler. */
export function riscoRoutes(overrides = {}) {
  return (call, res, calls) => {
    const route = routeOf(call.path);
    const override = overrides[route];
    if (override) return override(call, res, calls);
    switch (route) {
      case 'login':
        return reply(res, success({ accessToken: 'synthetic-token' }));
      case 'sites':
        return reply(res, success([{ id: siteId, name: 'Synthetic Home' }]));
      case 'siteLogin':
        return reply(res, success({ sessionId }));
      case 'state':
        return reply(res, panel());
      case 'arm':
        return reply(res, success({}));
      case 'events':
        // Hold an idle stream open until the test server closes its connections.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': synthetic keep-alive\n\n');
        return undefined;
      default:
        return reply(res, { status: 404, response: null }, 404);
    }
  };
}

export function routeOf(path) {
  if (path === '/webapi/api/auth/login') return 'login';
  if (path === '/webapi/api/wuws/site/GetAll') return 'sites';
  if (/^\/webapi\/api\/wuws\/site\/\d+\/Login$/.test(path)) return 'siteLogin';
  if (/\/ControlPanel\/GetState$/.test(path)) return 'state';
  if (/\/ControlPanel\/PartArm$/.test(path)) return 'arm';
  if (/\/ControlPanel\/sse\/connect(\?|$)/.test(path)) return 'events';
  return 'unknown';
}

export async function serverFor(t, handle) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://127.0.0.1');
    const call = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      route: routeOf(url.pathname),
      authorization: req.headers.authorization,
      sessionToken: req.headers.sessiontoken,
      body: body ? JSON.parse(body) : undefined,
    };
    calls.push(call);
    await handle(call, res, calls);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, calls };
}

export function reply(res, body, status = 200, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
