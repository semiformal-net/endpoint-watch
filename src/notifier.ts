import { NotificationEvent } from './types.ts';

export interface Notifier {
  send(event: NotificationEvent, token: string): Promise<void>;
}

export class HttpNotifier implements Notifier {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(event: NotificationEvent, token: string): Promise<void> {
    const message = buildAlertBody(event.oldValue, event.newValue);

    const res = await this.fetchImpl(this.url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'text/plain; charset=utf-8',
        'x-event-id': event.eventId,
        title: event.watchName,
      },
      body: message,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Notification failed with ${res.status}: ${body.slice(0, 256)}`);
    }
  }
}

export function buildAlertBody(oldValue: unknown, newValue: unknown): string {
  if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    return buildListDiffBody(oldValue, newValue);
  }
  return `${formatValue(oldValue)} -> ${formatValue(newValue)}`;
}

function buildListDiffBody(oldList: unknown[], newList: unknown[]): string {
  const oldMap = toStableMap(oldList);
  const newMap = toStableMap(newList);

  const removed: string[] = [];
  const added: string[] = [];

  for (const [key, display] of oldMap.entries()) {
    if (!newMap.has(key)) {
      removed.push(display);
    }
  }
  for (const [key, display] of newMap.entries()) {
    if (!oldMap.has(key)) {
      added.push(display);
    }
  }

  const removedText = removed.length > 0 ? removed.join(' | ') : '(none)';
  const addedText = added.length > 0 ? added.join(' | ') : '(none)';
  return `removed: ${removedText}\nadded: ${addedText}`;
}

function toStableMap(list: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of list) {
    const key = JSON.stringify(item);
    if (!map.has(key)) {
      map.set(key, formatValue(item));
    }
  }
  return map;
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}
