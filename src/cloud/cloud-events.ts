import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { CloudError, isRecord } from './cloud-error.js';
import { categoryFor, retryAfter } from './cloud-http.js';
import { vendorTime } from './cloud-protocol.js';

export interface StreamMessage {
  readonly event: string;
  readonly data: string;
}

/** `runtimeUpdate` says that something changed, not what: state must still be read. */
export interface RuntimeUpdate {
  readonly offline: boolean | undefined;
  readonly statusUpdatedAtMs: number | undefined;
  readonly eventUpdatedAtMs: number | undefined;
}

const maximumEventBytes = 64 * 1024;

/** Incremental text/event-stream parser (event and data fields; comments, id and retry ignored). */
export class EventStreamParser {
  #buffer = '';
  #event = '';
  #data: string[] = [];
  #size = 0;

  push(chunk: string): StreamMessage[] {
    this.#buffer += chunk;
    const messages: StreamMessage[] = [];
    for (;;) {
      const end = this.#buffer.search(/\r\n|\r|\n/);
      if (end < 0) break;
      const line = this.#buffer.slice(0, end);
      const newline = this.#buffer.startsWith('\r\n', end) ? 2 : 1;
      this.#buffer = this.#buffer.slice(end + newline);
      if (line === '') {
        if (this.#data.length > 0)
          messages.push({ event: this.#event || 'message', data: this.#data.join('\n') });
        this.#event = '';
        this.#data = [];
        this.#size = 0;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') this.#event = value.slice(0, 64);
      else if (field === 'data') {
        this.#size += value.length;
        this.#data.push(value);
      }
      if (this.#size > maximumEventBytes) throw new CloudError('invalid-response');
    }
    if (this.#buffer.length > maximumEventBytes) throw new CloudError('invalid-response');
    return messages;
  }
}

export function decodeRuntimeUpdate(data: string): RuntimeUpdate {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new CloudError('invalid-response');
  }
  if (!isRecord(value)) throw new CloudError('invalid-response');
  return {
    offline: typeof value.IsOffline === 'boolean' ? value.IsOffline : undefined,
    statusUpdatedAtMs: vendorTime(value.LastStatusUpdate),
    eventUpdatedAtMs: vendorTime(value.LastEventUpdated),
  };
}

export interface StreamCall {
  origin: string;
  path: string;
  token: string;
  sessionId: string;
  signal: AbortSignal;
  connectTimeoutMs: number;
  /** Reconnect when the server sends nothing, not even a comment, for this long. */
  idleTimeoutMs: number;
  now: () => number;
  onOpen: () => void;
  onMessage: (message: StreamMessage) => void;
}

/**
 * GET a server-sent event stream. Resolves on a clean end of stream and rejects with a fixed
 * category otherwise. Payloads and vendor text never cross this boundary except as messages.
 */
export async function openStream(call: StreamCall): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: CloudError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      call.signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    };
    const url = new URL(call.path, call.origin);
    url.searchParams.set('sessionToken', call.sessionId);
    let request: ReturnType<typeof httpsRequest>;
    const startTimer = (ms: number, category: 'timeout') => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish(new CloudError(category));
        request.destroy();
      }, ms);
    };
    const aborted = () => {
      finish(new CloudError('cancelled'));
      request.destroy();
    };
    try {
      request = (call.origin.startsWith('https:') ? httpsRequest : httpRequest)(
        url,
        {
          method: 'GET',
          agent: false,
          headers: {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            Authorization: `Bearer ${call.token}`,
            sessionToken: call.sessionId,
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const type = response.headers['content-type'] ?? '';
          if (status !== 200 || !type.toLowerCase().startsWith('text/event-stream')) {
            finish(
              new CloudError(
                status === 200 ? 'invalid-response' : categoryFor(status, true),
                retryAfter(response.headers['retry-after'], call.now()),
              ),
            );
            response.destroy();
            return;
          }
          call.onOpen();
          const parser = new EventStreamParser();
          response.setEncoding('utf8');
          startTimer(call.idleTimeoutMs, 'timeout');
          response.on('data', (chunk: string) => {
            startTimer(call.idleTimeoutMs, 'timeout');
            try {
              for (const message of parser.push(chunk)) call.onMessage(message);
            } catch (error) {
              finish(error instanceof CloudError ? error : new CloudError('invalid-response'));
              response.destroy();
            }
          });
          response.on('end', () => {
            finish();
          });
          response.on('error', () => {
            finish(new CloudError(call.signal.aborted ? 'cancelled' : 'unavailable'));
          });
        },
      );
      request.on('error', () => {
        finish(new CloudError(call.signal.aborted ? 'cancelled' : 'unavailable'));
      });
      if (call.signal.aborted) {
        aborted();
        return;
      }
      call.signal.addEventListener('abort', aborted, { once: true });
      startTimer(call.connectTimeoutMs, 'timeout');
      request.end();
    } catch {
      finish(new CloudError('invalid-request'));
    }
  });
}
