import { assertEquals } from '@std/assert';
import { buildAlertBody, HttpNotifier } from '../src/notifier.ts';
import { NotificationEvent } from '../src/types.ts';

Deno.test('HttpNotifier sends compact old->new message body', async () => {
  let capturedBody = '';
  let capturedContentType = '';
  let capturedTitle = '';

  const fakeFetch: typeof fetch = async (...args: Parameters<typeof fetch>) => {
    const init = args[1] as { body?: BodyInit | null; headers?: HeadersInit } | undefined;
    capturedBody = String(init?.body ?? '');
    const headers = new Headers(init?.headers);
    capturedContentType = headers.get('content-type') ?? '';
    capturedTitle = headers.get('title') ?? '';
    return new Response('ok', { status: 200 });
  };

  const notifier = new HttpNotifier('https://ntfy.example.com/topic', fakeFetch);
  const event: NotificationEvent = {
    eventId: 'e1',
    watchName: 'navidrome-latest-release',
    sourceUrl: 'https://api.github.com/repos/navidrome/navidrome/releases/latest',
    jsonpath: '$.tag_name',
    oldValue: '0.0.0',
    newValue: 'v2.18.0',
    oldHash: 'old',
    newHash: 'new',
    observedAt: new Date().toISOString(),
  };

  await notifier.send(event, 'token');

  assertEquals(capturedBody, '0.0.0 -> v2.18.0');
  assertEquals(capturedContentType, 'text/plain; charset=utf-8');
  assertEquals(capturedTitle, 'navidrome-latest-release');
});

Deno.test('buildAlertBody for list only shows added/removed items', () => {
  const oldList = ['Backend Engineer', 'Product Designer', 'DevOps Engineer'];
  const newList = ['Backend Engineer', 'Data Engineer', 'DevOps Engineer'];
  const message = buildAlertBody(oldList, newList);

  assertEquals(message.includes('Backend Engineer'), false);
  assertEquals(message.includes('DevOps Engineer'), false);
  assertEquals(message.includes('Product Designer'), true);
  assertEquals(message.includes('Data Engineer'), true);
});

Deno.test('buildAlertBody list added-only/removed-only and duplicate handling', () => {
  const addedOnly = buildAlertBody(['A'], ['A', 'B', 'B']);
  assertEquals(addedOnly.includes('removed: (none)'), true);
  assertEquals(addedOnly.includes('added: B'), true);

  const removedOnly = buildAlertBody(['A', 'C', 'C'], ['A']);
  assertEquals(removedOnly.includes('removed: C'), true);
  assertEquals(removedOnly.includes('added: (none)'), true);
});
