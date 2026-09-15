import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { CloudError, isRecord, type CloudErrorCategory } from './cloud-error.js';

export interface HttpCall {
  origin: string;
  path: string;
  body: unknown;
  token?: string;
  signal: AbortSignal;
  now: () => number;
}

/** Vendor result for a control-panel task that did not answer in time. */
const PANEL_TIMEOUT_RESULT = 72;

/** JSON POST only, no redirects, no raw errors crossing this boundary. */
export async function post(call: HttpCall): Promise<unknown> {
  let body: string;
  try {
    body = JSON.stringify(call.body);
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error();
  } catch {
    throw new CloudError('invalid-request');
  }
  return new Promise((resolve, reject) => {
    const fail = (error: CloudError) => {
      reject(error);
    };
    try {
      const request = (call.origin.startsWith('https:') ? httpsRequest : httpRequest)(
        new URL(call.path, call.origin),
        {
          method: 'POST',
          signal: call.signal,
          agent: false,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            ...(call.token ? { Authorization: `Bearer ${call.token}` } : {}),
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status !== 200) {
            fail(
              new CloudError(
                categoryFor(status, call.token !== undefined),
                retryAfter(response.headers['retry-after'], call.now()),
              ),
            );
            response.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024) {
              fail(new CloudError('invalid-response'));
              response.destroy();
            } else chunks.push(chunk);
          });
          response.on('error', () => {
            fail(new CloudError('unavailable'));
          });
          response.on('end', () => {
            try {
              resolve(envelope(JSON.parse(Buffer.concat(chunks).toString('utf8')), call));
            } catch (error) {
              fail(error instanceof CloudError ? error : new CloudError('invalid-response'));
            }
          });
        },
      );
      request.on('error', () => {
        fail(new CloudError(call.signal.aborted ? 'cancelled' : 'unavailable'));
      });
      request.end(body);
    } catch {
      fail(new CloudError('invalid-request'));
    }
  });
}

/**
 * RISCO wraps every reply as `{ status, errorText, result, response }` and may report an HTTP
 * failure inside a 200 reply. Vendor text is never surfaced.
 */
function envelope(value: unknown, call: HttpCall): unknown {
  if (!isRecord(value) || !Number.isInteger(value.status) || !('response' in value))
    throw new CloudError('invalid-response');
  if (value.status !== 200)
    throw new CloudError(categoryFor(value.status as number, call.token !== undefined));
  if (value.result !== undefined && value.result !== null) {
    if (!Number.isInteger(value.result)) throw new CloudError('invalid-response');
    if (value.result === PANEL_TIMEOUT_RESULT) throw new CloudError('panel-timeout');
    if (value.result !== 0) throw new CloudError('vendor-rejected');
  }
  return value.response;
}

function categoryFor(status: number, authenticated: boolean): CloudErrorCategory {
  if (status === 401) return authenticated ? 'session-expired' : 'invalid-credentials';
  if (status === 403) return 'permission-denied';
  if (status === 429) return 'rate-limited';
  if (status >= 500 && status <= 599) return 'unavailable';
  return 'invalid-response';
}

function retryAfter(value: string | undefined, now: number): number {
  if (!value) return 0;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, Number.MAX_SAFE_INTEGER) : 0;
}
