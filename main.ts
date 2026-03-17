import { configPathFromEnv, loadConfig } from './src/config.ts';
import { HttpNotifier } from './src/notifier.ts';
import { ChangeRunner } from './src/runner.ts';
import { buildHandler } from './src/server.ts';
import { DenoKvStateStore } from './src/state.ts';
import { parse as parseYaml } from '@std/yaml';

const configPath = configPathFromEnv();
const fallbackCron = '0 * * * *';
const cronSchedule = readCronScheduleSync(configPath) ?? fallbackCron;

interface AppRuntime {
  runner: ChangeRunner;
  handler: Deno.ServeHandler;
}

let runtimePromise: Promise<AppRuntime> | null = null;

function getRuntime(): Promise<AppRuntime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const config = await loadConfig(configPath);
      const kvPath = Deno.env.get('KV_PATH');
      // On Deploy, use managed KV unless KV_PATH is explicitly provided.
      const kv = kvPath ? await Deno.openKv(kvPath) : await Deno.openKv();
      const store = new DenoKvStateStore(kv);
      const notifier = new HttpNotifier(config.message.url, config.message.retry);
      const runner = new ChangeRunner(config, { store, notifier });
      return {
        runner,
        handler: buildHandler(runner, store),
      };
    })();
  }
  return runtimePromise;
}

function readCronScheduleSync(path: string | URL): string | null {
  try {
    const text = Deno.readTextFileSync(path);
    const raw = parseYaml(text) as Record<string, unknown> | null;
    const value = raw?.poll_cron;
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  } catch (err) {
    console.error('Failed reading cron schedule from config; using hourly fallback', {
      error: err instanceof Error ? err.message : String(err),
      configPath: String(path),
    });
  }
  return null;
}

Deno.cron('poll-change-detector', cronSchedule, async () => {
  try {
    const { runner } = await getRuntime();
    await runner.runOnce();
  } catch (err) {
    console.error('CRON RUN FAILED', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

const port = Number(Deno.env.get('PORT') ?? 8000);
console.log(`listening on :${port} using config ${String(configPath)} cron=${cronSchedule}`);
Deno.serve({ port }, async (req, info) => {
  const { handler } = await getRuntime();
  return await handler(req, info);
});
