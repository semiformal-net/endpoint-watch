import { canonicalize, hashCanonical, makeEventId } from './canonical.ts';
import { extractJsonPath } from './jsonpath.ts';
import { Notifier } from './notifier.ts';
import { StateStore } from './state.ts';
import {
  AppConfig,
  Logger,
  NotificationEvent,
  RunSummary,
  RunWatchResult,
  WatchConfig,
  WatchState,
} from './types.ts';

export interface RunnerDeps {
  store: StateStore;
  notifier: Notifier;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => Date;
  randomInt?: (max: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultLogger: Logger = {
  info(message: string, details?: Record<string, unknown>) {
    console.log(message, details ?? '');
  },
  error(message: string, details?: Record<string, unknown>) {
    console.error(message, details ?? '');
  },
};

function sanitizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ChangeRunner {
  #fetch: typeof fetch;
  #logger: Logger;
  #now: () => Date;
  #randomInt: (max: number) => number;
  #sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: AppConfig, private readonly deps: RunnerDeps) {
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#logger = deps.logger ?? defaultLogger;
    this.#now = deps.now ?? (() => new Date());
    this.#randomInt = deps.randomInt ?? ((max) => Math.floor(Math.random() * Math.max(1, max)));
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async runOnce(): Promise<RunSummary> {
    const startedAt = this.#now().toISOString();
    const results: RunWatchResult[] = [];
    for (const watch of this.config.watches) {
      if (this.config.runtime.perWatchJitterMs > 0) {
        await this.#sleep(this.#randomInt(this.config.runtime.perWatchJitterMs));
      }
      results.push(await this.#runWatch(watch));
    }
    return {
      startedAt,
      finishedAt: this.#now().toISOString(),
      results,
    };
  }

  async #runWatch(watch: WatchConfig): Promise<RunWatchResult> {
    try {
      const response = await this.#fetchWatchJson(watch);
      const extracted = extractJsonPath(response, watch.jsonpath);
      const canonical = canonicalize(extracted);
      const hash = await hashCanonical(canonical);
      const now = this.#now().toISOString();

      const prevEntry = await this.deps.store.get(watch.name);
      const prevState = prevEntry.state;

      let shouldNotify = false;
      if (!prevState) {
        shouldNotify = watch.notifyOnFirstObservation;
      } else if (prevState.valueHash !== hash) {
        shouldNotify = true;
      }

      if (shouldNotify) {
        const eventId = await makeEventId(watch.name, prevState?.valueHash, hash);
        const event: NotificationEvent = {
          eventId,
          watchName: watch.name,
          sourceUrl: watch.url,
          jsonpath: watch.jsonpath,
          oldValue: prevState?.value,
          newValue: canonical,
          oldHash: prevState?.valueHash,
          newHash: hash,
          observedAt: now,
        };

        const authToken = this.#resolveAuthToken();
        await this.deps.notifier.send(event, authToken);

        this.#logger.info(`CHANGE DETECTED [${watch.name}]`, {
          oldHash: prevState?.valueHash,
          newHash: hash,
          eventId,
        });

        const nextState: WatchState = {
          value: canonical,
          valueHash: hash,
          observedAt: now,
          sourceUrl: watch.url,
          jsonpath: watch.jsonpath,
          lastNotifyEventId: eventId,
          lastNotifyAt: now,
          lastSuccessAt: now,
          consecutiveFailures: 0,
        };
        await this.#commitStateWithCas(watch.name, nextState);
        return { watchName: watch.name, changed: true, notified: true };
      }

      const nextState: WatchState = {
        value: canonical,
        valueHash: hash,
        observedAt: now,
        sourceUrl: watch.url,
        jsonpath: watch.jsonpath,
        lastNotifyEventId: prevState?.lastNotifyEventId,
        lastNotifyAt: prevState?.lastNotifyAt,
        lastSuccessAt: now,
        consecutiveFailures: 0,
      };

      await this.#commitStateWithCas(watch.name, nextState);
      return { watchName: watch.name, changed: false, notified: false };
    } catch (err) {
      const message = sanitizeError(err);
      this.#logger.error(`WATCH FAILED [${watch.name}]`, { error: message });
      await this.#recordWatchError(watch, message);
      return { watchName: watch.name, changed: false, notified: false, error: message };
    }
  }

  #resolveAuthToken(): string {
    const fromEnv = Deno.env.get(this.config.message.authEnv);
    if (!fromEnv) {
      throw new Error(`Missing auth token env ${this.config.message.authEnv}`);
    }
    return fromEnv;
  }

  async #fetchWatchJson(watch: WatchConfig): Promise<unknown> {
    const headers = { ...watch.headers };
    if (watch.authEnv) {
      const token = Deno.env.get(watch.authEnv);
      if (!token) {
        throw new Error(`Missing upstream auth env ${watch.authEnv} for watch ${watch.name}`);
      }
      headers.authorization = `${watch.authPrefix ?? 'Bearer '}${token}`;
    }

    const res = await this.#fetch(watch.url, {
      method: watch.method,
      headers,
      signal: AbortSignal.timeout(watch.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Upstream ${watch.name} returned ${res.status}`);
    }

    try {
      return await res.json();
    } catch {
      throw new Error(`Upstream ${watch.name} returned invalid JSON`);
    }
  }

  async #commitStateWithCas(watchName: string, state: WatchState): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      const current = await this.deps.store.get(watchName);
      const ok = await this.deps.store.compareAndSet(watchName, current.versionstamp, state);
      if (ok) {
        return;
      }
    }
    throw new Error(`CAS failed repeatedly for ${watchName}`);
  }

  async #recordWatchError(watch: WatchConfig, errorMessage: string): Promise<void> {
    const now = this.#now().toISOString();
    const entry = await this.deps.store.get(watch.name);
    const prev = entry.state;
    if (!prev) {
      return;
    }
    const next: WatchState = {
      ...prev,
      lastErrorAt: now,
      lastError: errorMessage,
      consecutiveFailures: prev.consecutiveFailures + 1,
    };
    await this.deps.store.compareAndSet(watch.name, entry.versionstamp, next);
  }
}
