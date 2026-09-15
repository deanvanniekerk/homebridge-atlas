import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { RiscoClient } from './cloud-client.js';
import { CloudError, isRecord } from './cloud-error.js';
import { decodePanelState } from './panel-model.js';

// Read-only owner check of the RISCO Cloud mobile API. It never sends arm, disarm or bypass
// requests and prints only structure, counts and enumerated values: no names, tokens or PINs.

const shutdown = new AbortController();
process.once('SIGINT', () => {
  shutdown.abort();
});

function keys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort() : [];
}

function fieldUnion(items: unknown): string[] {
  return Array.isArray(items) ? [...new Set(items.flatMap(keys))].sort() : [];
}

function histogram(items: unknown, field: string): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!Array.isArray(items)) return counts;
  for (const item of items) {
    const raw = isRecord(item) ? item[field] : undefined;
    const key = typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : typeof raw;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('Run this in an interactive terminal.\n');
    process.exitCode = 2;
    return;
  }
  // readline's terminal echo goes to this sink; secrets never reach output or history.
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const prompt = createInterface({
    input: process.stdin,
    output: sink,
    terminal: true,
    historySize: 0,
  });
  const ask = async (message: string): Promise<string> => {
    process.stdout.write(message);
    const answer = await prompt.question('', { signal: shutdown.signal });
    process.stdout.write('\n');
    return answer.trim();
  };
  let client: RiscoClient | undefined;
  try {
    process.stdout.write(
      'Read-only RISCO Cloud check. Input is hidden. No arm, disarm or bypass request is sent.\n',
    );
    const username = await ask('Atlas / RISCO username (email): ');
    const password = await ask('Password: ');
    const pin = await ask('Panel user code (PIN): ');
    const siteInput = await ask('Site ID (leave blank if the account has one site): ');
    const siteId = siteInput === '' ? undefined : Number(siteInput);
    client = new RiscoClient({
      username,
      password,
      pin,
      ...(siteId === undefined ? {} : { siteId }),
    });

    const sites = await client.sites({ signal: shutdown.signal });
    process.stdout.write(`\nSign-in accepted. Sites visible: ${String(sites.length)}\n`);
    if (sites.length !== 1)
      for (const site of sites) process.stdout.write(`  site id ${String(site.id)}\n`);

    const result = await client.state({ signal: shutdown.signal });
    const status =
      isRecord(result.value) && isRecord(result.value.state) ? result.value.state.status : {};
    const raw = isRecord(status) ? status : {};
    const state = decodePanelState(result.value, {
      siteId: result.siteId,
      fromControlPanel: result.fromControlPanel,
      observedAtMs: Date.now(),
    });
    const reading = (value: { available: boolean; value?: unknown; reason?: string }) =>
      value.available ? String(value.value) : `unavailable(${String(value.reason)})`;

    const report = [
      `PIN session opened. State source: ${state.source}`,
      `Response keys: ${keys(result.value).join(', ')}`,
      `state keys: ${keys(isRecord(result.value) ? result.value.state : undefined).join(', ')}`,
      `state.status keys: ${keys(raw).join(', ')}`,
      `Partitions: ${String(state.partitions.length)}`,
      ...state.partitions.map(
        (partition) =>
          `  partition ${String(partition.id)}: arm=${reading(partition.arm)} alarm=${reading(partition.alarm)} exitDelay=${reading(partition.exitDelaySeconds)}`,
      ),
      `  partition fields: ${fieldUnion(raw.partitions).join(', ')}`,
      `  armedState values: ${JSON.stringify(histogram(raw.partitions, 'armedState'))}`,
      `Zones: ${String(state.zones.length)} (rejected records: ${String(state.rejectedRecords)})`,
      `  zone fields: ${fieldUnion(raw.zones).join(', ')}`,
      `  status values: ${JSON.stringify(histogram(raw.zones, 'status'))}`,
      `  zoneType values: ${JSON.stringify(histogram(raw.zones, 'zoneType'))}`,
      `  decoded conditions: ${JSON.stringify(
        state.zones.reduce<Record<string, number>>((counts, zone) => {
          const key = reading(zone.condition);
          counts[key] = (counts[key] ?? 0) + 1;
          return counts;
        }, {}),
      )}`,
    ];
    process.stdout.write(`${report.join('\n')}\n`);
  } catch (error) {
    const message = error instanceof CloudError ? error.message : 'The check failed unexpectedly.';
    const category = error instanceof CloudError ? ` [${error.category}]` : '';
    process.stderr.write(`\n${message}${category}\n`);
    process.exitCode = 1;
  } finally {
    client?.close();
    prompt.close();
    sink.destroy();
  }
}

await main();
