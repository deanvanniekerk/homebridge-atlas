import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseConfig, sensorKindFor } from './configuration.js';

const base = { username: 'synthetic@example.invalid', password: 'synthetic', pin: '1234' };

test('applies safe defaults with control disabled', () => {
  const config = parseConfig(base);
  assert.equal(config.name, 'Atlas');
  assert.equal(config.pollInterval, 30);
  assert.equal(config.updates, 'push');
  assert.equal(config.enableControl, false);
  assert.equal(config.partialArmMode, 'stay');
  assert.equal(config.includeZones, true);
  assert.equal(config.siteId, undefined);
  assert.equal(config.zones.size, 0);
});

test('parses explicit options and zone overrides', () => {
  const config = parseConfig({
    ...base,
    siteId: 42,
    pollInterval: 10,
    enableControl: true,
    partialArmMode: 'night',
    zones: [
      { id: 3, type: 'hidden' },
      { id: 4, name: 'Hall PIR', type: 'motion' },
    ],
  });
  assert.equal(config.siteId, 42);
  assert.equal(config.enableControl, true);
  assert.deepEqual(
    [...config.zones],
    [
      [3, 'hidden'],
      [4, 'motion'],
    ],
  );
});

test('rejects invalid fields without echoing values', () => {
  for (const [override, field] of [
    [{ pin: '12' }, 'pin'],
    [{ pin: 1234 }, 'pin'],
    [{ username: '' }, 'username'],
    [{ pollInterval: 5 }, 'pollInterval'],
    [{ updates: 'sse' }, 'updates'],
    [{ siteId: '42' }, 'siteId'],
    [{ partialArmMode: 'away' }, 'partialArmMode'],
    [{ enableControl: 'yes' }, 'enableControl'],
    [{ zones: [{ id: 1, type: 'door' }] }, 'zones'],
    [{ zones: [{ id: 1, name: 7, type: 'motion' }] }, 'zones'],
    [
      {
        zones: [
          { id: 1, type: 'motion' },
          { id: 1, type: 'contact' },
        ],
      },
      'zones',
    ],
  ]) {
    const error = (() => {
      try {
        parseConfig({ ...base, ...override });
      } catch (caught) {
        return caught;
      }
    })();
    assert.equal(error?.field, field);
    assert.doesNotMatch(error.message, /synthetic/);
  }
});

test('guesses motion sensors from common zone names', () => {
  for (const name of ['Lounge PIR', 'Garden Beam', 'Hall Motion'])
    assert.equal(sensorKindFor(name), 'motion');
  for (const name of ['Front Door', 'Kitchen Window', 'Garage Mag'])
    assert.equal(sensorKindFor(name), 'contact');
});
