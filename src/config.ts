import { parse as parseYaml } from '@std/yaml';
import { validateJsonPath } from './jsonpath.ts';
import { AppConfig, MessageConfig, RetryConfig, RuntimeConfig, WatchConfig } from './types.ts';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function asStringAllowEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function asPositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseRetry(raw: unknown): RetryConfig {
  const source = raw ? asRecord(raw, 'message.retry') : {};
  const maxAttempts = asPositiveInt(source.max_attempts ?? 3, 'message.retry.max_attempts');
  const baseDelayMs = asPositiveInt(source.base_delay_ms ?? 500, 'message.retry.base_delay_ms');
  const maxDelayMs = asPositiveInt(source.max_delay_ms ?? 5000, 'message.retry.max_delay_ms');
  const jitterMs = asPositiveInt(source.jitter_ms ?? 250, 'message.retry.jitter_ms');

  if (maxDelayMs < baseDelayMs) {
    throw new Error('message.retry.max_delay_ms must be >= base_delay_ms');
  }

  return { maxAttempts, baseDelayMs, maxDelayMs, jitterMs };
}

function parseMessage(raw: unknown): MessageConfig {
  const source = asRecord(raw, 'message');
  const url = asString(source.url, 'message.url');
  const authEnv = asString(source.auth_env, 'message.auth_env');

  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' &&
    parsed.hostname !== 'localhost'
  ) {
    throw new Error('message.url must use https (except localhost for local tests)');
  }

  return {
    url,
    authEnv,
    retry: parseRetry(source.retry),
  };
}

function parseRuntime(raw: unknown): RuntimeConfig {
  const source = raw ? asRecord(raw, 'runtime') : {};
  return {
    maxParallelWatches: asPositiveInt(
      source.max_parallel_watches ?? 4,
      'runtime.max_parallel_watches',
    ),
    perWatchJitterMs: asPositiveInt(
      source.per_watch_jitter_ms ?? 250,
      'runtime.per_watch_jitter_ms',
    ),
    runLeaseTtlSec: asPositiveInt(source.run_lease_ttl_sec ?? 300, 'runtime.run_lease_ttl_sec'),
  };
}

function parseHeaders(raw: unknown): Record<string, string> {
  if (!raw) {
    return {};
  }
  const source = asRecord(raw, 'watch.headers');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    headers[k.toLowerCase()] = asString(v, `watch.headers.${k}`);
  }
  return headers;
}

function parseWatch(
  raw: unknown,
  defaults: Record<string, unknown>,
  userAgent: string,
): WatchConfig {
  const source = asRecord(raw, 'watch');
  const name = asString(source.name, 'watch.name');
  const url = asString(source.url, `watch ${name}.url`);
  const jsonpath = asString(source.jsonpath ?? defaults.jsonpath, `watch ${name}.jsonpath`);
  validateJsonPath(jsonpath);

  const method = asString(source.method ?? defaults.method ?? 'GET', `watch ${name}.method`)
    .toUpperCase();
  const timeoutMs = asPositiveInt(
    source.timeout_ms ?? defaults.timeout_ms ?? 8000,
    `watch ${name}.timeout_ms`,
  );
  const notifyOnFirstObservation = Boolean(
    source.notify_on_first_observation ?? defaults.notify_on_first_observation ?? false,
  );
  const authEnv = source.auth_env ?? defaults.auth_env
    ? asString(source.auth_env ?? defaults.auth_env, `watch ${name}.auth_env`)
    : undefined;
  const authPrefix = source.auth_prefix ?? defaults.auth_prefix
    ? asStringAllowEmpty(source.auth_prefix ?? defaults.auth_prefix, `watch ${name}.auth_prefix`)
    : 'Bearer ';

  const headers = {
    ...parseHeaders(defaults.headers),
    ...parseHeaders(source.headers),
  };

  if (!headers.accept) {
    headers.accept = 'application/json';
  }
  if (!headers['user-agent']) {
    headers['user-agent'] = userAgent;
  }
  if (authEnv && headers.authorization) {
    throw new Error(
      `watch ${name} cannot set both auth_env and headers.authorization (ambiguous auth)`,
    );
  }

  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`watch ${name}.url must use http/https`);
  }

  return {
    name,
    url,
    jsonpath,
    headers,
    authEnv,
    authPrefix,
    method,
    timeoutMs,
    notifyOnFirstObservation,
  };
}

function parseConfigObject(raw: unknown): AppConfig {
  const source = asRecord(raw, 'config');
  const pollCron = asString(source.poll_cron ?? '0 */3 * * *', 'poll_cron');
  const userAgent = asString(source.user_agent ?? 'change-detector/0.2', 'user_agent');
  const runtime = parseRuntime(source.runtime);
  const message = parseMessage(source.message);

  const watchDefaults = source.watch_defaults
    ? asRecord(source.watch_defaults, 'watch_defaults')
    : {};
  if (!Array.isArray(source.watches) || source.watches.length === 0) {
    throw new Error('watches must be a non-empty array');
  }

  const watches = source.watches.map((watch) => parseWatch(watch, watchDefaults, userAgent));
  const seen = new Set<string>();
  for (const watch of watches) {
    if (seen.has(watch.name)) {
      throw new Error(`Duplicate watch name: ${watch.name}`);
    }
    seen.add(watch.name);
  }

  return {
    pollCron,
    userAgent,
    runtime,
    message,
    watches,
  };
}

function fileExists(path: string | URL): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(path: string | URL): Promise<AppConfig> {
  const text = await Deno.readTextFile(path);
  const raw = parseYaml(text);
  return parseConfigObject(raw);
}

export function configPathFromEnv(): string | URL {
  const fromEnv = Deno.env.get('CONFIG_PATH');
  if (fromEnv) {
    return fromEnv;
  }

  const configYaml = new URL('../config.yaml', import.meta.url);
  if (fileExists(configYaml)) {
    return configYaml;
  }

  const configLocalYaml = new URL('../config.local.yaml', import.meta.url);
  if (fileExists(configLocalYaml)) {
    return configLocalYaml;
  }

  return configYaml;
}
