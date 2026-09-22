import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'vitest';

// Execute the shipped settings page against a small DOM and Homebridge UI boundary.
function fakeElement(tag = 'div') {
  return {
    tag,
    value: '',
    textContent: '',
    checked: false,
    hidden: false,
    disabled: false,
    className: '',
    type: '',
    attributes: {},
    children: [],
    handlers: {},
    addEventListener(name, fn) {
      this.handlers[name] = fn;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren() {
      this.children = [];
    },
  };
}

async function page(initialConfig, respond) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  };
  let config = initialConfig;
  const updates = [];
  const saveButton = { enabled: true };
  const requests = [];
  const homebridge = {
    getPluginConfig: async () => config,
    updatePluginConfig: async (next) => {
      config = next;
      updates.push(structuredClone(next));
      return next;
    },
    disableSaveButton: () => {
      saveButton.enabled = false;
    },
    enableSaveButton: () => {
      saveButton.enabled = true;
    },
    request: async (path, body) => {
      requests.push(JSON.parse(JSON.stringify({ path, body })));
      return respond(body);
    },
  };
  const document = { getElementById: element, createElement: (tag) => fakeElement(tag) };
  vm.runInNewContext(await readFile('homebridge-ui/public/app.js', 'utf8'), {
    document,
    window: { homebridge },
    structuredClone,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // Objects created inside the vm context have foreign prototypes; compare plain copies.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  await settle();
  const rows = () =>
    element('zone-rows').children.map((row) => {
      const [show, name, now, type] = row.children;
      return {
        show: show.children[0],
        name: name.textContent,
        now: now.textContent,
        type: type.children[0],
      };
    });
  return {
    element,
    rows,
    requests,
    saveButton,
    settle,
    get config() {
      return plain(config);
    },
    updates,
    async fire(target, name) {
      target.handlers[name]();
      await settle();
    },
  };
}

const discovered = {
  kind: 'zones',
  siteId: 7,
  partitions: 1,
  zones: [
    { id: 0, name: 'Hall PIR', suggested: 'motion', condition: 'normal' },
    { id: 1, name: 'Front Door', suggested: 'contact', condition: 'triggered', fault: true },
    { id: 2, name: 'Arm Disarm', suggested: 'contact', condition: 'normal' },
  ],
};

const account = {
  platform: 'Atlas',
  name: 'Atlas',
  username: 'synthetic@example.invalid',
  password: 'synthetic',
  pin: '1234',
  _bridge: { username: '0E:00:00:00:00:01', port: 51000 },
};

test('loads detectors, then records visibility and type for every zone while preserving the bridge', async () => {
  const p = await page([structuredClone(account)], () => discovered);
  assert.equal(p.element('username').value, account.username);
  assert.equal(p.element('zone-table').hidden, true);
  await p.fire(p.element('load-zones'), 'click');
  assert.deepEqual(p.requests[0], {
    path: '/zones',
    body: {
      username: account.username,
      password: account.password,
      pin: '1234',
    },
  });
  const rows = p.rows();
  assert.deepEqual(
    rows.map((row) => [row.name, row.now, row.show.checked, row.type.value]),
    [
      ['Hall PIR', 'Closed / clear', true, 'motion'],
      ['Front Door', 'Open / active · Fault', true, 'contact'],
      ['Arm Disarm', 'Closed / clear', true, 'contact'],
    ],
  );
  rows[2].show.checked = false;
  await p.fire(rows[2].show, 'change');
  rows[1].type.value = 'motion';
  await p.fire(rows[1].type, 'change');
  const [saved] = p.config;
  assert.deepEqual(saved.zones, [
    { id: 0, name: 'Hall PIR', type: 'motion' },
    { id: 1, name: 'Front Door', type: 'motion' },
    { id: 2, name: 'Arm Disarm', type: 'hidden' },
  ]);
  assert.deepEqual(saved._bridge, account._bridge);
  assert.equal(saved.updates, 'push', 'push is the default update mode');
  assert.equal(p.element('zone-summary').textContent, '2 of 3 detectors shown in Apple Home.');
  assert.equal(p.saveButton.enabled, true);
});

test('saved choices are shown before loading and survive a reload', async () => {
  const p = await page(
    [
      {
        ...structuredClone(account),
        zones: [
          { id: 2, name: 'Arm Disarm', type: 'hidden' },
          { id: 1, name: 'Front Door', type: 'motion' },
          { id: 9, name: 'Old Zone', type: 'contact' },
        ],
      },
    ],
    () => discovered,
  );
  assert.deepEqual(
    p.rows().map((row) => [row.name, row.show.checked, row.type.value, row.type.disabled]),
    [
      ['Arm Disarm', false, 'contact', true],
      ['Front Door', true, 'motion', false],
      ['Old Zone', true, 'contact', false],
    ],
  );
  await p.fire(p.element('load-zones'), 'click');
  assert.deepEqual(p.config[0].zones, [
    { id: 0, name: 'Hall PIR', type: 'motion' },
    { id: 1, name: 'Front Door', type: 'motion' },
    { id: 2, name: 'Arm Disarm', type: 'hidden' },
    { id: 9, name: 'Old Zone', type: 'contact' },
  ]);
  assert.equal(p.rows()[3].now, 'Not reported');
  await p.fire(p.element('hide-all'), 'click');
  assert.ok(p.config[0].zones.every((zone) => zone.type === 'hidden'));
});

test('invalid account details block saving and loading; site choice feeds the site id', async () => {
  const p = await page([], (body) =>
    body.siteId === undefined
      ? {
          kind: 'site-required',
          sites: [
            { id: 1, name: 'Home' },
            { id: 2, name: 'Office' },
          ],
        }
      : discovered,
  );
  assert.equal(p.saveButton.enabled, false);
  await p.fire(p.element('load-zones'), 'click');
  assert.equal(p.requests.length, 0);
  p.element('username').value = 'synthetic@example.invalid';
  p.element('password').value = 'synthetic';
  p.element('pin').value = '12';
  await p.fire(p.element('pin'), 'input');
  assert.match(p.element('notice').textContent, /4–8 digits/);
  assert.equal(p.updates.length, 0);
  p.element('pin').value = '123456';
  await p.fire(p.element('pin'), 'input');
  assert.equal(p.saveButton.enabled, true);
  assert.equal(p.config[0].platform, 'Atlas');
  await p.fire(p.element('load-zones'), 'click');
  assert.equal(p.element('site-choice').hidden, false);
  p.element('site-select').value = '2';
  await p.fire(p.element('site-select'), 'change');
  assert.equal(p.config[0].siteId, 2);
  await p.fire(p.element('load-zones'), 'click');
  assert.equal(p.requests.at(-1).body.siteId, 2);
  assert.equal(p.rows().length, 3);
});

test('cloud failures show fixed messages without echoing server payloads', async () => {
  const p = await page([structuredClone(account)], () => {
    throw { message: 'x', error: { code: 'invalid-pin', detail: 'secret-server-text' } };
  });
  await p.fire(p.element('load-zones'), 'click');
  assert.match(p.element('notice').textContent, /keypad lockout/);
  assert.doesNotMatch(p.element('notice').textContent, /secret/);
  assert.equal(p.element('load-zones').disabled, false);
});
