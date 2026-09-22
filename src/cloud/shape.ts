import { isRecord } from './cloud-error.js';

/** Vendor field names, bounded, with anything unusual masked. */
export function fieldNames(value: unknown): string[] {
  return isRecord(value)
    ? Object.keys(value)
        .slice(0, 64)
        .map((key) => (/^[A-Za-z0-9_]{1,64}$/.test(key) ? key : '?'))
        .sort()
    : [];
}

/**
 * Structure of an unrecognized reply for debug logs: nested field names and value types only,
 * with arrays summarized by length and first element. Never includes values.
 */
export function shapeOf(value: unknown, depth = 4): unknown {
  if (Array.isArray(value))
    return depth > 0 && value.length > 0
      ? { array: value.length, first: shapeOf(value[0], depth - 1) }
      : { array: value.length };
  if (isRecord(value))
    return depth > 0
      ? Object.fromEntries(
          fieldNames(value).map((key) => [
            key,
            key === '?' ? 'field' : shapeOf(value[key], depth - 1),
          ]),
        )
      : 'object';
  return value === null ? 'null' : typeof value;
}
