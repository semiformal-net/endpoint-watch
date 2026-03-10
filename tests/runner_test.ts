import { assertEquals } from '@std/assert';
import { ChangeRunner } from '../src/runner.ts';
import { InMemoryStateStore, StateEntry, StateStore } from '../src/state.ts';
import { AppConfig, Logger, NotificationEvent, WatchState } from '../src/types.ts';

class CaptureNotifier {
  events: NotificationEvent[] = [];
  async send(event: NotificationEvent, _token: string): Promise<void> {
    this.events.push(event);
  }
}

class FlakyCasStore implements StateStore {
  readonly base = new InMemoryStateStore();
  attempts = 0;
  failNext = true;

  get(watchName: string): Promise<StateEntry> {
    return this.base.get(watchName);
  }

  async compareAndSet(
    watchName: string,
    expectedVersion: string | null,
    state: WatchState,
  ): Promise<boolean> {
    this.attempts += 1;
    if (this.failNext) {
      this.failNext = false;
      return false;
    }
    return await this.base.compareAndSet(watchName, expectedVersion, state);
  }

  list() {
    return this.base.list();
  }

  forceSet(watchName: string, state: WatchState) {
    return this.base.forceSet(watchName, state);
  }
}

function baseConfig(messageUrl: string): AppConfig {
  return {
    pollCron: '0 */3 * * *',
    userAgent: 'test-agent',
    runtime: {
      maxParallelWatches: 2,
      perWatchJitterMs: 0,
      runLeaseTtlSec: 120,
    },
    message: {
      url: messageUrl,
      authEnv: 'NTFY_AUTH_TOKEN',
      retry: {
        maxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 20,
        jitterMs: 0,
      },
    },
    watches: [
      {
        name: 'navidrome',
        url: 'https://api.github.com/repos/navidrome/navidrome/releases/latest',
        jsonpath: '$.tag_name',
        method: 'GET',
        timeoutMs: 5000,
        notifyOnFirstObservation: false,
        headers: {
          accept: 'application/vnd.github+json',
        },
      },
    ],
  };
}

Deno.test('runner detects drifted state and emits console-like alert', async () => {
  Deno.env.set('NTFY_AUTH_TOKEN', 'local-token');
  const store = new InMemoryStateStore();
  const notifier = new CaptureNotifier();
  const logs: string[] = [];
  const logger: Logger = {
    info(message) {
      logs.push(message);
    },
    error(message) {
      logs.push(`ERR:${message}`);
    },
  };

  const fakeFetch: typeof fetch = async () => {
    return new Response(JSON.stringify({ tag_name: 'v1.2.3' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const runner = new ChangeRunner(baseConfig('https://ntfy.example.com/topic'), {
    store,
    notifier,
    fetchImpl: fakeFetch,
    logger,
    sleep: async () => {},
  });

  const first = await runner.runOnce();
  assertEquals(first.results[0].changed, false);
  assertEquals(notifier.events.length, 0);

  await store.forceSet('navidrome', {
    value: 'v0.0.1',
    valueHash: 'bad-hash',
    observedAt: new Date().toISOString(),
    sourceUrl: 'https://api.github.com/repos/navidrome/navidrome/releases/latest',
    jsonpath: '$.tag_name',
    consecutiveFailures: 0,
  });

  const second = await runner.runOnce();
  assertEquals(second.results[0].changed, true);
  assertEquals(second.results[0].notified, true);
  assertEquals(notifier.events.length, 1);
  assertEquals(logs.some((msg) => msg.includes('CHANGE DETECTED [navidrome]')), true);
  Deno.env.delete('NTFY_AUTH_TOKEN');
});

Deno.test('runner no-change run does not notify', async () => {
  Deno.env.set('NTFY_AUTH_TOKEN', 'local-token');
  const store = new InMemoryStateStore();
  const notifier = new CaptureNotifier();
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ tag_name: 'v1.2.3' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const runner = new ChangeRunner(baseConfig('https://ntfy.example.com/topic'), {
    store,
    notifier,
    fetchImpl: fakeFetch,
    sleep: async () => {},
  });

  await runner.runOnce();
  const second = await runner.runOnce();
  assertEquals(second.results[0].changed, false);
  assertEquals(second.results[0].notified, false);
  assertEquals(notifier.events.length, 0);
  Deno.env.delete('NTFY_AUTH_TOKEN');
});

Deno.test('runner handles wildcard list extraction and stores full list state', async () => {
  Deno.env.set('NTFY_AUTH_TOKEN', 'local-token');
  const store = new InMemoryStateStore();
  const notifier = new CaptureNotifier();

  const ashbyUrl = 'https://api.ashbyhq.com/posting-api/job-board/wealthsimple';
  const config: AppConfig = {
    pollCron: '0 */3 * * *',
    userAgent: 'test-agent',
    runtime: { maxParallelWatches: 1, perWatchJitterMs: 0, runLeaseTtlSec: 120 },
    message: {
      url: 'https://ntfy.example.com/topic',
      authEnv: 'NTFY_AUTH_TOKEN',
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20, jitterMs: 0 },
    },
    watches: [
      {
        name: 'wealthsimple-jobs',
        url: ashbyUrl,
        jsonpath: '$.jobs[*].title',
        method: 'GET',
        timeoutMs: 5000,
        notifyOnFirstObservation: false,
        headers: { accept: 'application/json' },
      },
    ],
  };

  const latestTitles = ['Backend Engineer', 'Data Engineer', 'Product Designer'];
  const fakeFetch: typeof fetch = async (input) => {
    if (String(input) !== ashbyUrl) {
      throw new Error('unexpected URL');
    }
    return new Response(
      JSON.stringify({
        jobs: latestTitles.map((title) => ({ title })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const runner = new ChangeRunner(config, {
    store,
    notifier,
    fetchImpl: fakeFetch,
    sleep: async () => {},
  });

  await runner.runOnce();
  const baseline = await store.get('wealthsimple-jobs');
  assertEquals(baseline.state?.value, latestTitles);

  const oldDummyList = ['loris text alpha', 'Backend Engineer', 'loris text beta'];
  await store.forceSet('wealthsimple-jobs', {
    value: oldDummyList,
    valueHash: 'old-wealthsimple',
    observedAt: new Date().toISOString(),
    sourceUrl: ashbyUrl,
    jsonpath: '$.jobs[*].title',
    consecutiveFailures: 0,
  });

  const second = await runner.runOnce();
  assertEquals(second.results[0].changed, true);
  assertEquals(second.results[0].notified, true);
  assertEquals(notifier.events.length, 1);
  assertEquals(notifier.events[0].oldValue, oldDummyList);
  assertEquals(notifier.events[0].newValue, latestTitles);

  const persisted = await store.get('wealthsimple-jobs');
  assertEquals(persisted.state?.value, latestTitles);
  Deno.env.delete('NTFY_AUTH_TOKEN');
});

Deno.test('runner injects per-watch auth header from env', async () => {
  const store = new InMemoryStateStore();
  const notifier = new CaptureNotifier();
  Deno.env.set('NTFY_AUTH_TOKEN', 'local-token');
  Deno.env.set('GITHUB_TOKEN', 'secret-token-value');

  let capturedAuth = '';
  const fakeFetch: typeof fetch = async (_input, init) => {
    const headers = new Headers(
      (init as { headers?: HeadersInit } | undefined)?.headers,
    );
    capturedAuth = headers.get('authorization') ?? '';
    return new Response(JSON.stringify({ tag_name: 'v1.0.0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const config = baseConfig('https://ntfy.example.com/topic');
  config.watches[0].authEnv = 'GITHUB_TOKEN';
  config.watches[0].authPrefix = 'token ';

  const runner = new ChangeRunner(config, {
    store,
    notifier,
    fetchImpl: fakeFetch,
    sleep: async () => {},
  });

  await runner.runOnce();
  assertEquals(capturedAuth, 'token secret-token-value');
  Deno.env.delete('GITHUB_TOKEN');
  Deno.env.delete('NTFY_AUTH_TOKEN');
});

Deno.test('notification failure attempts once and does not advance state', async () => {
  Deno.env.set('NTFY_AUTH_TOKEN', 'local-token');
  const store = new InMemoryStateStore();
  const notifier = {
    calls: 0,
    async send(_event: NotificationEvent, _token: string): Promise<void> {
      this.calls += 1;
      throw new Error('ntfy down');
    },
  };
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ tag_name: 'v2.0.0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const runner = new ChangeRunner(baseConfig('https://ntfy.example.com/topic'), {
    store,
    notifier,
    fetchImpl: fakeFetch,
    sleep: async () => {},
  });

  await store.forceSet('navidrome', {
    value: 'v1.0.0',
    valueHash: 'old-hash',
    observedAt: new Date().toISOString(),
    sourceUrl: 'https://api.github.com/repos/navidrome/navidrome/releases/latest',
    jsonpath: '$.tag_name',
    consecutiveFailures: 0,
  });

  const result = await runner.runOnce();
  assertEquals(result.results[0].error?.includes('ntfy down'), true);
  assertEquals(notifier.calls, 1);

  const persisted = await store.get('navidrome');
  assertEquals(persisted.state?.value, 'v1.0.0');
  assertEquals(persisted.state?.valueHash, 'old-hash');
  Deno.env.delete('NTFY_AUTH_TOKEN');
});

Deno.test('missing message auth env fails watch and preserves prior state', async () => {
  Deno.env.delete('NTFY_AUTH_TOKEN');
  const store = new InMemoryStateStore();
  const notifier = new CaptureNotifier();
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ tag_name: 'v2.0.0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const runner = new ChangeRunner(baseConfig('https://ntfy.example.com/topic'), {
    store,
    notifier,
    fetchImpl: fakeFetch,
    sleep: async () => {},
  });

  await store.forceSet('navidrome', {
    value: 'v1.0.0',
    valueHash: 'old-hash',
    observedAt: new Date().toISOString(),
    sourceUrl: 'https://api.github.com/repos/navidrome/navidrome/releases/latest',
    jsonpath: '$.tag_name',
    consecutiveFailures: 0,
  });

  const result = await runner.runOnce();
  assertEquals(result.results[0].error?.includes('Missing auth token env'), true);
  const persisted = await store.get('navidrome');
  assertEquals(persisted.state?.valueHash, 'old-hash');
});

Deno.test('missing per-watch upstream auth env fails only that watch', async () => {
  Deno.env.set('NTFY_AUTH_TOKEN', 'local-token');
  Deno.env.delete('MISSING_WATCH_TOKEN');
  const store = new InMemoryStateStore();
  const notifier = new CaptureNotifier();

  const config: AppConfig = {
    pollCron: '0 */3 * * *',
    userAgent: 'test-agent',
    runtime: { maxParallelWatches: 2, perWatchJitterMs: 0, runLeaseTtlSec: 120 },
    message: {
      url: 'https://ntfy.example.com/topic',
      authEnv: 'NTFY_AUTH_TOKEN',
      retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10, jitterMs: 0 },
    },
    watches: [
      {
        name: 'good-watch',
        url: 'https://example.com/good',
        jsonpath: '$.tag_name',
        method: 'GET',
        timeoutMs: 5000,
        notifyOnFirstObservation: false,
        headers: { accept: 'application/json' },
      },
      {
        name: 'bad-auth-watch',
        url: 'https://example.com/bad',
        jsonpath: '$.tag_name',
        method: 'GET',
        timeoutMs: 5000,
        notifyOnFirstObservation: false,
        headers: { accept: 'application/json' },
        authEnv: 'MISSING_WATCH_TOKEN',
        authPrefix: 'Bearer ',
      },
    ],
  };

  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    return new Response(JSON.stringify({ tag_name: url.includes('good') ? 'v1' : 'v2' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const runner = new ChangeRunner(config, {
    store,
    notifier,
    fetchImpl: fakeFetch,
    sleep: async () => {},
  });

  await store.forceSet('good-watch', {
    value: 'v0',
    valueHash: 'old-good',
    observedAt: new Date().toISOString(),
    sourceUrl: 'https://example.com/good',
    jsonpath: '$.tag_name',
    consecutiveFailures: 0,
  });
  await store.forceSet('bad-auth-watch', {
    value: 'v0',
    valueHash: 'old-bad',
    observedAt: new Date().toISOString(),
    sourceUrl: 'https://example.com/bad',
    jsonpath: '$.tag_name',
    consecutiveFailures: 0,
  });

  const summary = await runner.runOnce();
  const good = summary.results.find((r) => r.watchName === 'good-watch');
  const bad = summary.results.find((r) => r.watchName === 'bad-auth-watch');
  assertEquals(good?.notified, true);
  assertEquals(bad?.error?.includes('Missing upstream auth env'), true);
  Deno.env.delete('NTFY_AUTH_TOKEN');
});

Deno.test('invalid upstream payloads do not stop other watches', async () => {
  Deno.env.set('NTFY_AUTH_TOKEN', 'local-token');
  const store = new InMemoryStateStore();
  const notifier = new CaptureNotifier();

  const config: AppConfig = {
    pollCron: '0 */3 * * *',
    userAgent: 'test-agent',
    runtime: { maxParallelWatches: 3, perWatchJitterMs: 0, runLeaseTtlSec: 120 },
    message: {
      url: 'https://ntfy.example.com/topic',
      authEnv: 'NTFY_AUTH_TOKEN',
      retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10, jitterMs: 0 },
    },
    watches: [
      {
        name: 'bad-status',
        url: 'https://example.com/500',
        jsonpath: '$.tag_name',
        method: 'GET',
        timeoutMs: 5000,
        notifyOnFirstObservation: false,
        headers: { accept: 'application/json' },
      },
      {
        name: 'bad-json',
        url: 'https://example.com/not-json',
        jsonpath: '$.tag_name',
        method: 'GET',
        timeoutMs: 5000,
        notifyOnFirstObservation: false,
        headers: { accept: 'application/json' },
      },
      {
        name: 'good',
        url: 'https://example.com/good',
        jsonpath: '$.tag_name',
        method: 'GET',
        timeoutMs: 5000,
        notifyOnFirstObservation: false,
        headers: { accept: 'application/json' },
      },
    ],
  };

  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/500')) {
      return new Response('oops', { status: 500 });
    }
    if (url.includes('/not-json')) {
      return new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify({ tag_name: 'v2.0.0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await store.forceSet('good', {
    value: 'v1.0.0',
    valueHash: 'old-good',
    observedAt: new Date().toISOString(),
    sourceUrl: 'https://example.com/good',
    jsonpath: '$.tag_name',
    consecutiveFailures: 0,
  });

  const runner = new ChangeRunner(config, {
    store,
    notifier,
    fetchImpl: fakeFetch,
    sleep: async () => {},
  });

  const summary = await runner.runOnce();
  assertEquals(
    summary.results.find((r) => r.watchName === 'bad-status')?.error !== undefined,
    true,
  );
  assertEquals(summary.results.find((r) => r.watchName === 'bad-json')?.error !== undefined, true);
  assertEquals(summary.results.find((r) => r.watchName === 'good')?.notified, true);
  Deno.env.delete('NTFY_AUTH_TOKEN');
});

Deno.test('runner retries CAS on conflict and succeeds', async () => {
  Deno.env.set('NTFY_AUTH_TOKEN', 'local-token');
  const store = new FlakyCasStore();
  const notifier = new CaptureNotifier();
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ tag_name: 'v1.2.3' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const runner = new ChangeRunner(baseConfig('https://ntfy.example.com/topic'), {
    store,
    notifier,
    fetchImpl: fakeFetch,
    sleep: async () => {},
  });

  await runner.runOnce();
  assertEquals(store.attempts >= 2, true);
  Deno.env.delete('NTFY_AUTH_TOKEN');
});

Deno.test({
  name: 'live test: github APIs + forced drift + ntfy push payloads',
  ignore: Deno.env.get('RUN_LIVE_TESTS') !== '1',
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const payloads: NotificationEvent[] = [];
  const ac = new AbortController();
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, signal: ac.signal }, async (req) => {
    if (req.method !== 'PUT') {
      return new Response('method not allowed', { status: 405 });
    }
    const body = (await req.json()) as NotificationEvent;
    payloads.push(body);
    return new Response('ok', { status: 200 });
  });

  try {
    const address = server.addr as Deno.NetAddr;
    const store = new InMemoryStateStore();
    const notifier = {
      async send(event: NotificationEvent, _token: string): Promise<void> {
        const res = await fetch(`http://127.0.0.1:${address.port}/topic`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(event),
        });
        if (!res.ok) {
          throw new Error(`mock ntfy failed: ${res.status}`);
        }
      },
    };

    const config: AppConfig = {
      pollCron: '0 */3 * * *',
      userAgent: 'test-agent',
      runtime: { maxParallelWatches: 2, perWatchJitterMs: 0, runLeaseTtlSec: 120 },
      message: {
        url: `http://127.0.0.1:${address.port}/topic`,
        authEnv: 'NTFY_AUTH_TOKEN',
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500, jitterMs: 0 },
      },
      watches: [
        {
          name: 'navidrome-latest-release',
          url: 'https://api.github.com/repos/navidrome/navidrome/releases/latest',
          jsonpath: '$.tag_name',
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'change-detector-test' },
          method: 'GET',
          timeoutMs: 10000,
          notifyOnFirstObservation: false,
        },
        {
          name: 'ntfy-latest-release',
          url: 'https://api.github.com/repos/binwiederhier/ntfy/releases/latest',
          jsonpath: '$.tag_name',
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'change-detector-test' },
          method: 'GET',
          timeoutMs: 10000,
          notifyOnFirstObservation: false,
        },
      ],
    };

    const runner = new ChangeRunner(config, {
      store,
      notifier,
      sleep: async () => {},
    });

    Deno.env.set('NTFY_AUTH_TOKEN', 'local-token');
    await runner.runOnce();

    await store.forceSet('navidrome-latest-release', {
      value: 'v0.0.1',
      valueHash: 'old-navidrome',
      observedAt: new Date().toISOString(),
      sourceUrl: config.watches[0].url,
      jsonpath: '$.tag_name',
      consecutiveFailures: 0,
    });
    await store.forceSet('ntfy-latest-release', {
      value: 'v0.0.1',
      valueHash: 'old-ntfy',
      observedAt: new Date().toISOString(),
      sourceUrl: config.watches[1].url,
      jsonpath: '$.tag_name',
      consecutiveFailures: 0,
    });

    const summary = await runner.runOnce();
    assertEquals(summary.results.filter((r) => r.changed).length, 2);
    assertEquals(payloads.length, 2);
    Deno.env.delete('NTFY_AUTH_TOKEN');
  } finally {
    ac.abort();
    await server.finished;
  }
});
