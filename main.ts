// Lifecycle: listen on an ephemeral port, register it with the trial
// environment, then long-poll until the trial is done and exit 0.
//
// The environment URL comes from MAKEFUN_ENV_URL; without it there is
// nothing to register with, so the process exits 1.

import { createAppServer } from './src/app.ts';
import { Store } from './src/store.ts';

const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
if (envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const store = new Store(token);
const server = createAppServer(store);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, value: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(10_000),
  });
}

async function main(): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('Server did not bind a TCP port');
    return 1;
  }
  const port = address.port;

  let registered = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await postJson(`${envUrl}/register`, { port });
      if (response.ok || response.status === 409) {
        registered = true;
        break;
      }
    } catch {
      // The environment may not be ready yet; retry.
    }
    await sleep(500);
  }
  if (!registered) {
    console.error('Could not register with the trial environment');
    server.close();
    return 1;
  }

  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        if (payload !== null && typeof payload === 'object' && (payload as Record<string, unknown>)['done'] === true) {
          break;
        }
      }
    } catch {
      // A transient poll failure is not a reason to quit.
    }
    await sleep(1000);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
