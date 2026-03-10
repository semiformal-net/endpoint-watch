import { assertEquals, assertRejects } from '@std/assert';
import { loadConfig } from '../src/config.ts';

Deno.test('loadConfig parses local test config', async () => {
  const path = await Deno.makeTempFile({ dir: '.', suffix: '.yaml' });
  await Deno.writeTextFile(
    path,
    `poll_cron: "0 */3 * * *"
message:
  url: "https://ntfy.example.com/topic"
  auth_env: "NTFY_AUTH_TOKEN"
watches:
  - name: "a"
    url: "https://api.github.com/repos/navidrome/navidrome/releases/latest"
    jsonpath: "$.tag_name"
`,
  );
  const config = await loadConfig(path);
  assertEquals(config.watches.length, 1);
  assertEquals(config.watches[0].method, 'GET');
  assertEquals(config.watches[0].headers.accept, 'application/json');
  await Deno.remove(path);
});

Deno.test('loadConfig allows per-watch accept override', async () => {
  const path = await Deno.makeTempFile({ dir: '.', suffix: '.yaml' });
  await Deno.writeTextFile(
    path,
    `message:
  url: "https://ntfy.example.com/topic"
  auth_env: "NTFY_AUTH_TOKEN"
watches:
  - name: "ashby"
    url: "https://api.ashbyhq.com/posting-api/job-board/wealthsimple"
    jsonpath: "$.jobs[*].title"
    headers:
      accept: "application/vnd.custom+json"
`,
  );

  const config = await loadConfig(path);
  assertEquals(config.watches[0].headers.accept, 'application/vnd.custom+json');
  await Deno.remove(path);
});

Deno.test('loadConfig parses optional per-watch auth env and prefix', async () => {
  const path = await Deno.makeTempFile({ dir: '.', suffix: '.yaml' });
  await Deno.writeTextFile(
    path,
    `message:
  url: "https://ntfy.example.com/topic"
  auth_env: "NTFY_AUTH_TOKEN"
watches:
  - name: "github-release"
    url: "https://api.github.com/repos/navidrome/navidrome/releases/latest"
    jsonpath: "$.tag_name"
    auth_env: "GITHUB_TOKEN"
    auth_prefix: "token "
`,
  );

  const config = await loadConfig(path);
  assertEquals(config.watches[0].authEnv, 'GITHUB_TOKEN');
  assertEquals(config.watches[0].authPrefix, 'token ');
  await Deno.remove(path);
});

Deno.test('loadConfig rejects ambiguous per-watch auth headers', async () => {
  const path = await Deno.makeTempFile({ dir: '.', suffix: '.yaml' });
  await Deno.writeTextFile(
    path,
    `message:
  url: "https://ntfy.example.com/topic"
  auth_env: "NTFY_AUTH_TOKEN"
watches:
  - name: "github-release"
    url: "https://api.github.com/repos/navidrome/navidrome/releases/latest"
    jsonpath: "$.tag_name"
    auth_env: "GITHUB_TOKEN"
    headers:
      authorization: "Bearer hardcoded"
`,
  );

  await assertRejects(
    () => loadConfig(path),
    Error,
    'cannot set both auth_env and headers.authorization',
  );
  await Deno.remove(path);
});

Deno.test('loadConfig requires message.auth_env', async () => {
  const path = await Deno.makeTempFile({ dir: '.', suffix: '.yaml' });
  await Deno.writeTextFile(
    path,
    `message:
  url: "https://ntfy.example.com/topic"
watches:
  - name: "a"
    url: "https://api.github.com/repos/navidrome/navidrome/releases/latest"
    jsonpath: "$.tag_name"
`,
  );

  await assertRejects(() => loadConfig(path), Error, 'message.auth_env must be a non-empty string');
  await Deno.remove(path);
});

Deno.test('loadConfig rejects duplicate watch names', async () => {
  const path = await Deno.makeTempFile({ dir: '.', suffix: '.yaml' });
  await Deno.writeTextFile(
    path,
    `message:
  url: "https://ntfy.example.com/topic"
  auth_env: "NTFY_AUTH_TOKEN"
watches:
  - name: "dup"
    url: "https://example.com/a"
    jsonpath: "$.a"
  - name: "dup"
    url: "https://example.com/b"
    jsonpath: "$.b"
`,
  );
  await assertRejects(() => loadConfig(path), Error, 'Duplicate watch name');
  await Deno.remove(path);
});

Deno.test('loadConfig rejects invalid watch URL scheme', async () => {
  const path = await Deno.makeTempFile({ dir: '.', suffix: '.yaml' });
  await Deno.writeTextFile(
    path,
    `message:
  url: "https://ntfy.example.com/topic"
  auth_env: "NTFY_AUTH_TOKEN"
watches:
  - name: "bad-url"
    url: "ftp://example.com/data.json"
    jsonpath: "$.a"
`,
  );
  await assertRejects(() => loadConfig(path), Error, 'must use http/https');
  await Deno.remove(path);
});

Deno.test('loadConfig rejects invalid retry bounds', async () => {
  const path = await Deno.makeTempFile({ dir: '.', suffix: '.yaml' });
  await Deno.writeTextFile(
    path,
    `message:
  url: "https://ntfy.example.com/topic"
  auth_env: "NTFY_AUTH_TOKEN"
  retry:
    max_attempts: 1
    base_delay_ms: 1000
    max_delay_ms: 100
    jitter_ms: 10
watches:
  - name: "a"
    url: "https://example.com/a"
    jsonpath: "$.a"
`,
  );
  await assertRejects(() => loadConfig(path), Error, 'max_delay_ms must be >= base_delay_ms');
  await Deno.remove(path);
});
