import { ChangeRunner } from './runner.ts';
import { StateStore } from './state.ts';

export function buildHandler(runner: ChangeRunner, store: StateStore): Deno.ServeHandler {
  return async (req) => {
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (req.method === 'POST' && url.pathname === '/run') {
      const summary = await runner.runOnce();
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      const state = await store.list();
      return new Response(JSON.stringify(state, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  };
}
