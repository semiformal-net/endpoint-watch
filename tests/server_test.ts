import { assertEquals } from '@std/assert';
import { ChangeRunner } from '../src/runner.ts';
import { buildHandler } from '../src/server.ts';
import { InMemoryStateStore } from '../src/state.ts';
import { AppConfig } from '../src/types.ts';

Deno.test('/state endpoint returns expected shape and does not leak env secret', async () => {
  const store = new InMemoryStateStore();
  await store.forceSet('demo-watch', {
    value: 'v1.2.3',
    valueHash: 'hash123',
    observedAt: new Date().toISOString(),
    sourceUrl: 'https://example.com',
    jsonpath: '$.tag_name',
    consecutiveFailures: 0,
  });

  const config: AppConfig = {
    pollCron: '0 */3 * * *',
    userAgent: 'test-agent',
    runtime: { maxParallelWatches: 1, perWatchJitterMs: 1, runLeaseTtlSec: 120 },
    message: {
      url: 'https://ntfy.example.com/topic',
      authEnv: 'NTFY_AUTH_TOKEN',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterMs: 1 },
    },
    watches: [],
  };

  const runner = new ChangeRunner(config, {
    store,
    notifier: { async send() {} },
    fetchImpl: async () => new Response('{}', { status: 200 }),
    sleep: async () => {},
  });

  Deno.env.set('NTFY_AUTH_TOKEN', 'super-secret-token');
  const handler = buildHandler(runner, store);
  const res = await handler(new Request('http://localhost/state'), {} as Deno.ServeHandlerInfo);
  const body = await res.text();

  assertEquals(res.status, 200);
  assertEquals(body.includes('demo-watch'), true);
  assertEquals(body.includes('"valueHash": "hash123"'), true);
  assertEquals(body.includes('super-secret-token'), false);

  Deno.env.delete('NTFY_AUTH_TOKEN');
});
