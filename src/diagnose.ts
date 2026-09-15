import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { RiscoClient } from './cloud-client.js';
import { CloudError } from './cloud-error.js';
import { panelReport } from './diagnostics.js';
import { decodePanelState } from './panel-model.js';

// Read-only owner check of the RISCO Cloud mobile API. It never sends arm, disarm or bypass
// requests and prints only structure, counts and enumerated values: no names, tokens or PINs.

const shutdown = new AbortController();
process.once('SIGINT', () => {
  shutdown.abort();
});

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
    const state = decodePanelState(result.value, {
      siteId: result.siteId,
      fromControlPanel: result.fromControlPanel,
      observedAtMs: Date.now(),
    });
    process.stdout.write(
      `PIN session opened. Panel report:\n${JSON.stringify(panelReport(state), null, 2)}\n`,
    );
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
