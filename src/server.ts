export function buildHandler(): Deno.ServeHandler {
  return (_req) => {
    return new Response('Not Found', { status: 404 });
  };
}
