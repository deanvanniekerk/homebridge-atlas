export type CloudErrorCategory =
  | 'invalid-credentials'
  | 'invalid-pin'
  | 'site-selection'
  | 'permission-denied'
  | 'session-expired'
  | 'session-contention'
  | 'panel-timeout'
  | 'rate-limited'
  | 'unavailable'
  | 'invalid-response'
  | 'vendor-rejected'
  | 'timeout'
  | 'cancelled'
  | 'invalid-request';

const messages: Record<CloudErrorCategory, string> = {
  'invalid-credentials': 'Authentication rejected. Check credentials and reload configuration.',
  'invalid-pin':
    'The panel rejected the user code. Traffic is paused to avoid a keypad lockout; check the PIN and restart.',
  'site-selection':
    'The configured site was not found, or the account has several sites. Set the site ID and restart.',
  'permission-denied': 'Access denied. Check account or site permissions.',
  'session-expired': 'The cloud session is no longer valid.',
  'session-contention':
    'Repeated session invalidation. Another client may be using this account; cooling down.',
  'panel-timeout': 'The cloud timed out waiting for the control panel.',
  'rate-limited': 'The cloud service requested a delay.',
  unavailable: 'The cloud service is temporarily unavailable.',
  'invalid-response': 'The cloud response does not match the supported protocol.',
  'vendor-rejected': 'The cloud service rejected the operation with an unrecognized vendor result.',
  timeout: 'The cloud operation exceeded its time budget.',
  cancelled: 'The cloud operation was cancelled.',
  'invalid-request': 'The cloud request or client configuration is invalid.',
};

/** Safe to log: no vendor text, URL, payload, token, or original error cause is retained. */
export class CloudError extends Error {
  constructor(
    readonly category: CloudErrorCategory,
    readonly retryAfterMs = 0,
    readonly deliveryUncertain = false,
  ) {
    super(messages[category]);
    this.name = 'CloudError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
