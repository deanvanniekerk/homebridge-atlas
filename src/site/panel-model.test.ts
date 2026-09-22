import assert from 'node:assert/strict';
import { test } from 'vitest';
import { panel } from '../cloud/fake-cloud.test-support.js';
import { decodePanelState } from './panel-model.js';

const context = { siteId: 7, fromControlPanel: true, observedAtMs: 1000 };
const decode = (value, overrides = {}) => decodePanelState(value, { ...context, ...overrides });

test('decodes partitions and zone conditions from GetState', () => {
  const state = decode(panel().response);
  assert.equal(state.source, 'panel');
  assert.deepEqual(state.partitions, [
    {
      id: 0,
      arm: { available: true, value: 'disarmed' },
      alarm: { available: true, value: false },
      exitDelaySeconds: { available: true, value: 0 },
      ready: { available: true, value: false },
    },
  ]);
  assert.deepEqual(state.online, { available: true, value: true });
  assert.deepEqual(
    state.zones.map((zone) => [zone.id, zone.name, zone.type, zone.condition, zone.trouble.value]),
    [
      [0, 'Hall PIR', 3, { available: true, value: 'normal' }, false],
      [1, 'Front Door', 1, { available: true, value: 'triggered' }, false],
      [4, 'Garden Beam', 3, { available: true, value: 'bypassed' }, true],
    ],
  );
  assert.equal(decode(panel().response, { fromControlPanel: false }).source, 'cloud');
});

test('maps every armed state and keeps unknown vendor values unavailable', () => {
  const state = decode(
    panel({
      partitions: [
        { id: 0, armedState: 2, alarmState: 1, exitDelayTO: 30 },
        { id: 1, armedState: 3, alarmState: 0, exitDelayTO: 0 },
        { id: 2, armedState: 9, alarmState: 'x' },
      ],
      zones: [{ zoneID: 3, status: 7 }],
    }).response,
  );
  assert.deepEqual(
    state.partitions.map((p) => [p.arm, p.alarm, p.exitDelaySeconds]),
    [
      [
        { available: true, value: 'partial' },
        { available: true, value: true },
        { available: true, value: 30 },
      ],
      [
        { available: true, value: 'armed' },
        { available: true, value: false },
        { available: true, value: 0 },
      ],
      [
        { available: false, reason: 'unrecognized' },
        { available: false, reason: 'invalid' },
        { available: false, reason: 'missing' },
      ],
    ],
  );
  assert.equal(state.zones[0].name, 'Zone 3');
  assert.equal(state.zones[0].type, undefined);
  assert.deepEqual(state.zones[0].condition, { available: false, reason: 'unrecognized' });
});

test('drops records without a valid unique identity and counts them', () => {
  const state = decode(
    panel({
      partitions: [{ id: 0, armedState: 1 }, { id: 0, armedState: 3 }, { armedState: 1 }],
      zones: [{ zoneID: 1, status: 0 }, 'bad', { zoneID: -2, status: 0 }],
    }).response,
  );
  assert.equal(state.partitions.length, 1);
  assert.equal(state.partitions[0].arm.value, 'disarmed');
  assert.equal(state.zones.length, 1);
  assert.equal(state.rejectedRecords, 4);
});

test('rejects responses without the state envelope', () => {
  for (const value of [null, {}, { state: {} }, { state: { status: { partitions: [] } } }])
    assert.throws(() => decode(value), { category: 'invalid-response' });
});
