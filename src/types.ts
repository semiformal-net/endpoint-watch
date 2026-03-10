export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
}

export interface MessageConfig {
  url: string;
  authEnv: string;
  retry: RetryConfig;
}

export interface RuntimeConfig {
  maxParallelWatches: number;
  perWatchJitterMs: number;
  runLeaseTtlSec: number;
}

export interface WatchConfig {
  name: string;
  url: string;
  jsonpath: string;
  headers: Record<string, string>;
  authEnv?: string;
  authPrefix?: string;
  method: string;
  timeoutMs: number;
  notifyOnFirstObservation: boolean;
}

export interface AppConfig {
  pollCron: string;
  userAgent: string;
  runtime: RuntimeConfig;
  message: MessageConfig;
  watches: WatchConfig[];
}

export interface WatchState {
  value: unknown;
  valueHash: string;
  observedAt: string;
  sourceUrl: string;
  jsonpath: string;
  lastNotifyEventId?: string;
  lastNotifyAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  consecutiveFailures: number;
  lastError?: string;
}

export interface NotificationEvent {
  eventId: string;
  watchName: string;
  sourceUrl: string;
  jsonpath: string;
  oldValue: unknown;
  newValue: unknown;
  oldHash?: string;
  newHash: string;
  observedAt: string;
}

export interface RunWatchResult {
  watchName: string;
  changed: boolean;
  notified: boolean;
  error?: string;
}

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  results: RunWatchResult[];
}

export interface Logger {
  info(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}
