import { configPathFromEnv, loadConfig } from './src/config.ts';
import { HttpNotifier } from './src/notifier.ts';
import { ChangeRunner } from './src/runner.ts';
import { buildHandler } from './src/server.ts';
import { DenoKvStateStore } from './src/state.ts';

const configPath = configPathFromEnv();
const config = await loadConfig(configPath);
const kvPath = Deno.env.get('KV_PATH');
// On Deploy, use managed KV unless KV_PATH is explicitly provided.
const kv = kvPath ? await Deno.openKv(kvPath) : await Deno.openKv();
const store = new DenoKvStateStore(kv);
const notifier = new HttpNotifier(config.message.url);
const runner = new ChangeRunner(config, { store, notifier });

Deno.cron('poll-change-detector', config.pollCron, async () => {
  await runner.runOnce();
});

const port = Number(Deno.env.get('PORT') ?? 8000);
console.log(`listening on :${port} using config ${configPath}`);
Deno.serve({ port }, buildHandler(runner, store));
