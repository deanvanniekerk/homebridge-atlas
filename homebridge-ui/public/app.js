(() => {
  const ui = window.homebridge;
  const el = (id) => document.getElementById(id);
  const fields = ['username', 'password', 'pin', 'site-id', 'name', 'poll-interval'];
  const conditions = {
    normal: 'Closed / clear',
    triggered: 'Open / active',
    bypassed: 'Bypassed',
    missing: 'Not reported',
  };
  let configs = [];
  let block = { platform: 'Atlas' };
  // Zone id -> { id, name, type, visible, condition }. Order follows the panel.
  let zones = new Map();
  let busy = false;

  const notify = (message) => {
    el('notice').textContent = message;
  };

  function readAccount() {
    const siteText = el('site-id').value.trim();
    return {
      username: el('username').value.trim(),
      password: el('password').value,
      pin: el('pin').value.trim(),
      siteId: siteText === '' ? undefined : Number(siteText),
    };
  }

  function accountProblem(account) {
    if (!account.username) return 'Enter the email you use in the Atlas app.';
    if (!/\S/.test(account.password)) return 'Enter your Atlas password.';
    if (!/^\d{4,8}$/.test(account.pin)) return 'Enter the panel user code as 4–8 digits.';
    if (
      account.siteId !== undefined &&
      !(Number.isSafeInteger(account.siteId) && account.siteId >= 0)
    )
      return 'Site ID must be a whole number, or blank.';
    return undefined;
  }

  function nextBlock() {
    const account = readAccount();
    const poll = Number(el('poll-interval').value);
    const next = {
      ...block,
      platform: 'Atlas',
      name: el('name').value.trim() || 'Atlas',
      username: account.username,
      password: account.password,
      pin: account.pin,
      pollInterval: Number.isInteger(poll) && poll >= 10 && poll <= 300 ? poll : 30,
      debug: el('debug').checked,
      enableControl: el('enable-control').checked,
      partialArmMode: el('partial-arm-mode').value === 'night' ? 'night' : 'stay',
    };
    if (account.siteId === undefined) delete next.siteId;
    else next.siteId = account.siteId;
    if (zones.size > 0)
      next.zones = [...zones.values()].map((zone) => ({
        id: zone.id,
        name: zone.name,
        type: zone.visible ? zone.type : 'hidden',
      }));
    return next;
  }

  async function sync() {
    const problem = accountProblem(readAccount());
    if (problem) {
      ui.disableSaveButton();
      notify(problem);
      return;
    }
    block = nextBlock();
    configs = [block, ...configs.slice(1)];
    await ui.updatePluginConfig(configs);
    ui.enableSaveButton();
    notify('');
  }

  function option(select, value, label) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    select.append(node);
  }

  function renderZones() {
    const rows = el('zone-rows');
    rows.replaceChildren();
    for (const zone of zones.values()) {
      const row = document.createElement('tr');
      row.className = zone.visible ? '' : 'hidden-zone';
      const show = document.createElement('input');
      show.type = 'checkbox';
      show.checked = zone.visible;
      show.setAttribute('aria-label', `Show ${zone.name}`);
      show.addEventListener('change', () => {
        zone.visible = show.checked;
        row.className = zone.visible ? '' : 'hidden-zone';
        type.disabled = !zone.visible;
        renderSummary();
        void sync();
      });
      const type = document.createElement('select');
      type.className = 'form-control form-control-sm';
      type.setAttribute('aria-label', `Type for ${zone.name}`);
      option(type, 'motion', 'Motion sensor');
      option(type, 'contact', 'Contact sensor');
      type.value = zone.type;
      type.disabled = !zone.visible;
      type.addEventListener('change', () => {
        zone.type = type.value === 'motion' ? 'motion' : 'contact';
        void sync();
      });
      const cells = [show, zone.name, conditions[zone.condition] ?? '—', type].map((content) => {
        const cell = document.createElement('td');
        if (typeof content === 'string') cell.textContent = content;
        else cell.append(content);
        return cell;
      });
      row.append(...cells);
      rows.append(row);
    }
    renderSummary();
  }

  function renderSummary() {
    const visible = [...zones.values()].filter((zone) => zone.visible).length;
    el('zone-table').hidden = zones.size === 0;
    el('show-all').hidden = zones.size === 0;
    el('hide-all').hidden = zones.size === 0;
    el('zone-summary').textContent =
      zones.size === 0
        ? 'No detectors loaded yet.'
        : `${visible} of ${zones.size} detectors shown in Apple Home.`;
  }

  function setAll(visible) {
    for (const zone of zones.values()) zone.visible = visible;
    renderZones();
    void sync();
  }

  const messages = {
    'invalid-credentials': 'The email or password was rejected.',
    'invalid-pin':
      'The panel rejected the user code. Check it before trying again to avoid a keypad lockout.',
    'site-selection': 'The site ID was not found for this account.',
    'permission-denied': 'This user is not allowed to access the site.',
    'invalid-request': 'Check the email, password, PIN and site ID.',
    'rate-limited': 'RISCO Cloud asked us to wait. Try again in a minute.',
    'session-contention': 'Another sign-in is in progress. Try again in a few minutes.',
    timeout: 'RISCO Cloud did not answer in time. Try again.',
  };

  async function loadZones() {
    if (busy) return;
    const account = readAccount();
    const problem = accountProblem(account);
    if (problem) {
      notify(problem);
      return;
    }
    busy = true;
    el('load-zones').disabled = true;
    notify('Signing in and reading your panel… this can take up to a minute.');
    try {
      const result = await ui.request('/zones', account);
      if (result.kind === 'site-required') {
        const select = el('site-select');
        select.replaceChildren();
        option(select, '', 'Choose a site');
        for (const site of result.sites) option(select, String(site.id), site.name);
        el('site-choice').hidden = false;
        notify('Choose your site, then load detectors again.');
        return;
      }
      const previous = zones;
      zones = new Map();
      for (const found of result.zones) {
        const saved = previous.get(found.id);
        zones.set(found.id, {
          id: found.id,
          name: found.name,
          type: saved ? saved.type : found.suggested,
          visible: saved ? saved.visible : true,
          condition: found.condition,
        });
      }
      // Keep saved choices for detectors the panel did not report this time.
      for (const saved of previous.values())
        if (!zones.has(saved.id)) zones.set(saved.id, { ...saved, condition: 'missing' });
      renderZones();
      await sync();
      notify(`Loaded ${result.zones.length} detectors. Adjust them, then click Save.`);
    } catch (error) {
      notify(
        messages[error?.error?.code] ??
          'RISCO Cloud could not complete the request. Please try again later.',
      );
    } finally {
      busy = false;
      el('load-zones').disabled = false;
    }
  }

  async function start() {
    configs = await ui.getPluginConfig();
    block = configs[0] ?? { platform: 'Atlas' };
    if (configs.length === 0) configs = [block];
    el('username').value = block.username ?? '';
    el('password').value = block.password ?? '';
    el('pin').value = block.pin ?? '';
    el('site-id').value = block.siteId === undefined ? '' : String(block.siteId);
    el('name').value = block.name ?? 'Atlas';
    el('poll-interval').value = String(block.pollInterval ?? 30);
    el('debug').checked = block.debug === true;
    el('enable-control').checked = block.enableControl === true;
    el('partial-arm-mode').value = block.partialArmMode === 'night' ? 'night' : 'stay';
    zones = new Map();
    for (const saved of Array.isArray(block.zones) ? block.zones : []) {
      if (!Number.isSafeInteger(saved?.id)) continue;
      zones.set(saved.id, {
        id: saved.id,
        name: typeof saved.name === 'string' && saved.name ? saved.name : `Zone ${saved.id}`,
        type: saved.type === 'motion' ? 'motion' : 'contact',
        visible: saved.type !== 'hidden',
        condition: undefined,
      });
    }
    renderZones();
    for (const id of fields) el(id).addEventListener('input', () => void sync());
    for (const id of ['debug', 'enable-control', 'partial-arm-mode'])
      el(id).addEventListener('change', () => void sync());
    el('site-select').addEventListener('change', () => {
      el('site-id').value = el('site-select').value;
      void sync();
    });
    el('load-zones').addEventListener('click', () => void loadZones());
    el('show-all').addEventListener('click', () => setAll(true));
    el('hide-all').addEventListener('click', () => setAll(false));
    if (accountProblem(readAccount())) ui.disableSaveButton();
  }

  void start();
})();
