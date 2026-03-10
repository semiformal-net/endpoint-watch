# JSON Change Detector for Deno

Track simple changes in JSON endpoints and get notified only when values change.

This project is built for Deno and Deno Deploy. It polls configured endpoints, extracts values with
JSONPath, stores prior state in Deno KV, and sends `ntfy` alerts when differences are detected.

A common use case is tracking version changes in GitHub release APIs:

- `https://api.github.com/repos/navidrome/navidrome/releases/latest`
- `https://api.github.com/repos/binwiederhier/ntfy/releases/latest`
- JSONPath: `$.tag_name`

## How It Works

1. Poll each configured watch endpoint.
2. Extract a value with JSONPath.
3. Canonicalize + hash the extracted value.
4. Compare to previous stored state.
5. If changed, send an `ntfy` alert and update state.

## Configuration

The app reads `config.yaml` by default (or `CONFIG_PATH` if set).

### Example `config.yaml`

```yaml
poll_cron: '0 */3 * * *'
user_agent: 'change-detector/0.2-local'

runtime:
  max_parallel_watches: 2
  per_watch_jitter_ms: 200
  run_lease_ttl_sec: 300

message:
  url: 'https://ntfy.sh/your-topic'
  auth_env: 'NTFY_AUTH_TOKEN'
  retry:
    max_attempts: 3
    base_delay_ms: 500
    max_delay_ms: 5000
    jitter_ms: 250

watch_defaults:
  timeout_ms: 10000
  method: 'GET'
  notify_on_first_observation: false

watches:
  - name: 'navidrome-latest-release'
    url: 'https://api.github.com/repos/navidrome/navidrome/releases/latest'
    jsonpath: '$.tag_name'
    auth_env: 'GITHUB_TOKEN'
    auth_prefix: 'token '
    headers:
      accept: 'application/vnd.github+json'

  - name: 'openai-jobs'
    url: 'https://api.ashbyhq.com/posting-api/job-board/openai'
    jsonpath: '$.jobs[*].title'
```

### Config fields

- `poll_cron`: cron schedule for `Deno.cron()`.
- `message.url`: ntfy topic URL.
- `message.auth_env`: env var name containing ntfy token.
- `message.retry.*`: retry settings for outgoing notifications.
- `watch_defaults.*`: default method/timeout/first-run behavior.
- `watches[]`: endpoints to monitor.

Per-watch fields:

- `name`: unique watch ID.
- `url`: JSON endpoint.
- `jsonpath`: extraction path.
- `headers`: optional HTTP headers.
- `auth_env`: optional env var for upstream API token.
- `auth_prefix`: optional prefix before token (default `Bearer`; for GitHub use `token`).
- `notify_on_first_observation`: whether first observation should notify.

### JSONPath support

Supported:

- `$.foo.bar`
- `$.items[0].name`
- `$.jobs[*].title`
- `$.releases[0]["tag-name"]`

Extraction behavior:

- 0 matches -> `null`
- 1 match -> scalar/object
- 2+ matches -> array

## Secrets / Environment Variables

Do not store tokens in YAML.

Set secrets via environment variables:

```bash
export NTFY_AUTH_TOKEN='...'
export GITHUB_TOKEN='...'
```

## Run Locally

```bash
deno task start
```

App endpoints:

- `POST /run` - trigger a run immediately
- `GET /state` - inspect watch state
- `GET /health` - health check

## Run Tests

### Standard local suite

```bash
deno task test
```

### Include live GitHub integration test

```bash
RUN_LIVE_TESTS=1 deno task test
```

This verifies live fetches from GitHub release endpoints and forced state drift detection.

## Manual End-to-End Alert Test

1. Ensure `NTFY_AUTH_TOKEN` (and optional `GITHUB_TOKEN`) is exported.
2. Start app locally: `deno task start`
3. Trigger one baseline run:
   - `curl -X POST http://127.0.0.1:8000/run`
4. Force stale state and run again (to trigger alerts):
   - use `Deno.openKv()` to set old values in `watch_state` keys, then call `/run` again.

Expected result: changed watches show `notified: true` and ntfy receives alert(s).

## Deploy to Deno Deploy

You can deploy either from the dashboard or CLI.

### Option A: Dashboard (GitHub)

1. Push this repo to GitHub.
2. Open Deno Deploy and create a new app from your GitHub repository.
3. Set:
   - runtime mode: dynamic/server
   - entrypoint: `main.ts`
   - app directory: repo root (`.`)
4. Add environment variables in the Deploy app settings:
   - `NTFY_AUTH_TOKEN` (secret)
   - `GITHUB_TOKEN` (optional, for higher GitHub API rate limit)
   - ensure `KV_PATH` is **not** set on Deploy (managed Deploy KV should be used)
5. Deploy and verify logs.
6. Trigger a run (`/run`) and confirm alerts are sent.

### Option B: CLI (`deno deploy`)

Example local-directory creation command:

```bash
deno deploy create `pwd` \
    --org <my-org> \
    --app endpoint-watch \
    --source local \
    --runtime-mode dynamic \
    --app-directory . \
    --working-directory . \
    --entrypoint main.ts \
    --region global
```

Region options are `global`, `us`, or `eu`.

After the app is created, deploy updates from the current local directory:

```bash
deno deploy --org <your-org> --app <your-app-name>
```

Then configure secrets:

```bash
deno deploy env add NTFY_AUTH_TOKEN '...' --secret --org <your-org> --app <your-app-name>
deno deploy env add GITHUB_TOKEN '...' --secret --org <your-org> --app <your-app-name>
deno deploy env delete KV_PATH --org <your-org> --app <your-app-name>
```

Useful commands:

```bash
deno deploy logs --org <your-org> --app <your-app-name>
deno deploy env list --org <your-org> --app <your-app-name>
```

## Notes

- Default upstream `Accept` header is `application/json` unless overridden.
- Alert title is the watch name.
- Alert body:
  - scalar change: `old -> new`
  - list change: compact `removed` / `added` diff (common items omitted).
- On Deploy, leave `KV_PATH` unset so state is stored in managed Deploy KV.
- If `/run` succeeds but `/state` stays `{}`, verify `KV_PATH` is not configured in app env vars.

## Portability (Cloudflare Workers)

This project can be ported to Cloudflare Workers, but it is intentionally optimized for Deno KV.

- Deno-specific pieces (`Deno.cron`, `Deno.serve`, `Deno.env`, `Deno.openKv`) would need
  Cloudflare equivalents (`scheduled`, Worker `fetch`, bindings, KV/DO/D1 storage).
- The main design requirement here is race-safe state updates after successful notifications.
- Deno KV provides this model cleanly with atomic compare-and-set semantics.
- Cloudflare KV is eventually consistent and is generally not a good fit for this state-transition
  pattern.
- Durable Objects can provide strong consistency per object, but add more architectural complexity.

Current recommendation: use Deno/Deno Deploy for this project unless you specifically need Cloudflare edge integration.
