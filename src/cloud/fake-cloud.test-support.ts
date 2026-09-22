import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { onTestFinished } from 'vitest';

export interface FakeCall {
  method: string | undefined;
  path: string;
  query: Record<string, string>;
  route: string;
  authorization: string | undefined;
  sessionToken: string | undefined;
  body: Record<string, unknown>;
}

type RouteHandler = (
  call: FakeCall,
  response: ServerResponse,
  calls?: FakeCall[],
) => void | Promise<void>;
type PanelOptions = { partitions?: unknown[]; zones?: unknown[]; online?: unknown };

// All responses and identities in this file are synthetic, not captured traffic. The envelope
// and field names follow the RISCO Cloud mobile API as used by public integrations.
export const success = <T>(response: T) => ({
  status: 200,
  errorText: null,
  result: 0,
  response,
});
export const failure = (fields: Record<string, unknown>) => ({
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

export function panel({ partitions, zones, online = true }: PanelOptions = {}) {
  return success({
    state: {
      isOnline: online,
      status: {
        partitions: partitions ?? [
          { id: 0, armedState: 1, alarmState: 0, exitDelayTO: 0, readyState: 0 },
        ],
        zones: zones ?? [
          { zoneID: 0, zoneName: 'Hall PIR', zoneType: 3, status: 0, trouble: false },
          { zoneID: 1, zoneName: 'Front Door', zoneType: 1, status: 1, trouble: false },
          { zoneID: 4, zoneName: 'Garden Beam', zoneType: 3, status: 2, trouble: true },
        ],
      },
    },
  });
}

/** Default happy-path RISCO cloud; `overrides[name]` replaces a route's handler. */
export function riscoRoutes(overrides: Partial<Record<string, RouteHandler>> = {}): RouteHandler {
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

export function routeOf(path: string): string {
  if (path === '/webapi/api/auth/login') return 'login';
  if (path === '/webapi/api/wuws/site/GetAll') return 'sites';
  if (/^\/webapi\/api\/wuws\/site\/\d+\/Login$/.test(path)) return 'siteLogin';
  if (/\/ControlPanel\/GetState$/.test(path)) return 'state';
  if (/\/ControlPanel\/PartArm$/.test(path)) return 'arm';
  if (/\/ControlPanel\/sse\/connect(\?|$)/.test(path)) return 'events';
  return 'unknown';
}

export async function serverFor(handle: RouteHandler) {
  const calls: FakeCall[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const call: FakeCall = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      route: routeOf(url.pathname),
      authorization: req.headers.authorization,
      sessionToken: req.headers.sessiontoken,
      body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
    };
    calls.push(call);
    await handle(call, res, calls);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake cloud did not bind a port.');
  return { origin: `http://127.0.0.1:${address.port}`, calls };
}

export function reply(
  res: ServerResponse,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
