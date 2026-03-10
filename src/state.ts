import { WatchState } from './types.ts';

export interface StateEntry {
  state: WatchState | null;
  versionstamp: string | null;
}

export interface StateStore {
  get(watchName: string): Promise<StateEntry>;
  compareAndSet(
    watchName: string,
    expectedVersion: string | null,
    state: WatchState,
  ): Promise<boolean>;
  list(): Promise<Record<string, WatchState>>;
  forceSet(watchName: string, state: WatchState): Promise<void>;
}

export class InMemoryStateStore implements StateStore {
  #map = new Map<string, { state: WatchState; version: number }>();

  async get(watchName: string): Promise<StateEntry> {
    const entry = this.#map.get(watchName);
    if (!entry) {
      return { state: null, versionstamp: null };
    }
    return { state: structuredClone(entry.state), versionstamp: String(entry.version) };
  }

  async compareAndSet(
    watchName: string,
    expectedVersion: string | null,
    state: WatchState,
  ): Promise<boolean> {
    const current = this.#map.get(watchName);
    const currentVersion = current ? String(current.version) : null;
    if (currentVersion !== expectedVersion) {
      return false;
    }
    const nextVersion = current ? current.version + 1 : 1;
    this.#map.set(watchName, { state: structuredClone(state), version: nextVersion });
    return true;
  }

  async list(): Promise<Record<string, WatchState>> {
    const out: Record<string, WatchState> = {};
    for (const [name, value] of this.#map.entries()) {
      out[name] = structuredClone(value.state);
    }
    return out;
  }

  async forceSet(watchName: string, state: WatchState): Promise<void> {
    const current = this.#map.get(watchName);
    const nextVersion = current ? current.version + 1 : 1;
    this.#map.set(watchName, { state: structuredClone(state), version: nextVersion });
  }
}

export class DenoKvStateStore implements StateStore {
  constructor(private readonly kv: Deno.Kv) {}

  async get(watchName: string): Promise<StateEntry> {
    const key = ['watch_state', watchName];
    const entry = await this.kv.get<WatchState>(key);
    return {
      state: entry.value ? structuredClone(entry.value) : null,
      versionstamp: entry.versionstamp,
    };
  }

  async compareAndSet(
    watchName: string,
    expectedVersion: string | null,
    state: WatchState,
  ): Promise<boolean> {
    const key = ['watch_state', watchName];
    const res = await this.kv.atomic()
      .check({ key, versionstamp: expectedVersion })
      .set(key, state)
      .commit();
    return res.ok;
  }

  async list(): Promise<Record<string, WatchState>> {
    const out: Record<string, WatchState> = {};
    for await (const entry of this.kv.list<WatchState>({ prefix: ['watch_state'] })) {
      const name = String(entry.key[1]);
      out[name] = structuredClone(entry.value);
    }
    return out;
  }

  async forceSet(watchName: string, state: WatchState): Promise<void> {
    await this.kv.set(['watch_state', watchName], state);
  }
}
