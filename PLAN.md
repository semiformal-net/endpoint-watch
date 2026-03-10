# Deno Change Detection App Plan

## Goal

Build a small serverless app on Deno Deploy that polls JSON APIs on a schedule, extracts values with
JSONPath, stores prior values in Deno KV, and sends an authenticated HTTP `PUT` notification to an
ntfy endpoint when a value changes.

## Core requirements

- Run on a schedule, such as every 3 hours
- Fetch JSON from one or more configured endpoints
- Extract one or more values using simple JSONPath expressions
- Persist prior observed state in a KV store
- Compare current extracted value to prior value
- On change, send an authenticated HTTPS `PUT` notification
- Keep all auth tokens in environment-based secrets
- Define explicit first-run behavior per watch (`notify_on_first_observation`)
- Avoid duplicate notifications during retries and overlapping runs
- Support a local end-to-end workflow using real GitHub APIs plus forced state drift
- Stay simple enough for free-tier use
- Be easy to test locally before deploying

## High-level architecture

```text
Deno.cron() / POST /run
  -> load + validate YAML config
  -> acquire run lease (optional global or per-watch)
  -> for each watch (bounded concurrency + jitter):
       fetch endpoint with timeout
       parse JSON
       apply JSONPath
       canonicalize result
       compute hash
       read previous state from Deno KV
       evaluate first-run + change policy
       if should_notify:
         build event payload + deterministic event_id
         send ntfy HTTP PUT with auth token from env
         if notification succeeds:
           atomically update KV state
         else:
           keep previous state unchanged (next scheduled run retries naturally)
       record watch success/failure metadata
  -> release lease
```

## Main components

### 1. Configuration loader and validation

Use a `config.yaml` file checked into the repo and validate it at startup.

Config contains:

- Poll schedule
- Messaging endpoint definition
- Optional global defaults (timeouts, retries, concurrency)
- List of watched endpoints
- JSONPath expression per endpoint
- Optional per-watch headers and method overrides
- Optional per-watch first-run behavior

Validation rules:

- `poll_cron` must be valid cron syntax for `Deno.cron()`
- Watch names must be unique
- URLs must be valid; notification URL should require `https` by default
- Timeout/retry fields must be bounded positive integers
- `message.auth_env` must be set (notification auth is env-only)
- JSONPath expressions should be pre-validated at startup

Example structure:

```yaml
poll_cron: '0 */3 * * *'
user_agent: 'change-detector/0.2'

runtime:
  max_parallel_watches: 4
  per_watch_jitter_ms: 400
  run_lease_ttl_sec: 300

message:
  url: 'https://ntfy.example.com/topic'
  auth_env: 'NTFY_AUTH_TOKEN'
  retry:
    max_attempts: 3
    base_delay_ms: 500
    max_delay_ms: 5000
    jitter_ms: 250

watch_defaults:
  timeout_ms: 8000
  method: 'GET'
  notify_on_first_observation: false

watches:
  - name: 'github-release'
    url: 'https://api.github.com/repos/owner/repo/releases/latest'
    jsonpath: '$.tag_name'
    headers:
      accept: 'application/vnd.github+json'
```

Local testing config file in repo:

- `config.local.yaml` should only reference env vars for secrets
- User sets secret values in shell env or `.env` (gitignored)

### 2. Scheduler and manual trigger

Use `Deno.cron()` to trigger polling on configured cadence.

Expose manual endpoints for operations and local testing:

- `POST /run` for ad hoc execution
- `GET /health` for basic health
- `GET /state` for sanitized state inspection (no secrets)

### 3. Concurrency control and leases

Guard against overlapping `cron` and manual runs:

- Acquire a short-lived lease in KV before run
- Skip or fail fast if another run currently owns lease
- Use lease TTL to avoid deadlock on crashes

Per-watch writes still use atomic compare-and-set to prevent stale overwrites.

### 4. Upstream fetcher

For each watch:

- Perform HTTP request with `fetch()`
- Apply configured method and headers
- Enforce timeout with `AbortSignal.timeout()`
- Parse response as JSON
- Treat non-2xx responses as errors
- Apply bounded concurrency and small jitter across watches

### 5. JSON extraction

Use a JSONPath library compatible with Deno.

Behavior:

- No matches -> `null`
- One match -> scalar or object
- Multiple matches -> array

This keeps results predictable and similar to simple `jq` usage.

### 6. Canonical comparison and hashing

To avoid false positives caused by object key ordering:

- Recursively sort object keys
- Serialize normalized structure with `JSON.stringify()`
- Compute stable hash (e.g., SHA-256) of canonical string
- Compare by hash for change detection

Store both canonical value and hash for debuggability + efficient comparisons.

### 7. State storage model

Use Deno KV with per-watch keys:

```text
["watch_state", watch.name]
```

Stored value includes:

- `value` (canonical extracted value)
- `value_hash`
- `observed_at`
- `source_url`
- `jsonpath`
- `last_notify_event_id`
- `last_notify_at`
- `last_success_at`
- `last_error_at`
- `consecutive_failures`
- `last_error` (sanitized)

### 8. Change decision policy

Decision per watch:

- First observation + `notify_on_first_observation=false` -> store state, no notify
- First observation + `notify_on_first_observation=true` -> notify then store
- Existing state + hash unchanged -> no notify
- Existing state + hash changed -> notify then store on success

### 9. Change notification and idempotency

If notify is required:

- Build payload: watcher name, URL, JSONPath, old value, new value, timestamp
- Generate deterministic `event_id` from watch name + old hash + new hash
- Send authenticated HTTP `PUT` to ntfy
- Include `event_id` as header and payload field for dedup
- Read auth token from `message.auth_env`

Never log raw auth tokens or sensitive headers.

### 10. Single-attempt notify and atomic write-after-notify

Notification send policy:

- Try notification once per run for fast execution
- If notification fails, do not advance state; next run naturally retries

State advancement policy:

- Only update watch state after notification success
- Use `kv.atomic().check(prev).set(...).commit()`
- On CAS conflict, re-read state and re-evaluate to avoid stale writes

## Error-handling plan

- A failed watch should not stop other watches from running
- Aggregate per-watch failures and log clearly
- Failed notification should prevent state advancement for that watch
- Invalid config should fail fast at startup
- Invalid JSONPath should fail startup validation
- Timeouts should be explicit and configurable
- Lease contention should be surfaced as an operational event, not a crash
- Error logs should be structured and sanitized

## Local testing plan

### Mock notification sink

Run a local HTTP server that accepts `PUT` and prints:

- Path
- Selected headers (redacted)
- Body

This verifies outbound notifications, auth wiring, and idempotency headers.

### Mock upstream API

Run a local HTTP server that returns JSON from a file-backed value.

Example response:

```json
{
  "data": {
    "current": {
      "status": "alpha"
    }
  }
}
```

Change backing file values (`alpha` -> `beta`) to verify detection.

### Manual verification flow

1. Start fake ntfy receiver
2. Start fake upstream API
3. Export `NTFY_AUTH_TOKEN=testtoken`
4. Run the Deno app locally
5. Call `POST /run` with empty KV
6. Verify first-run behavior matches `notify_on_first_observation`
7. Call `POST /run` again with unchanged upstream data and verify no notify
8. Change upstream value and call `POST /run` again
9. Verify notification includes deterministic `event_id`
10. Simulate ntfy failure and verify state does not advance
11. Trigger concurrent runs and verify lease/CAS prevent duplicate state writes
12. Inspect `GET /state` and verify state metadata fields

### Local end-to-end workflow (real GitHub APIs)

Use real upstream endpoints and the same JSONPath filter (`$.tag_name`) for both:

- `https://api.github.com/repos/navidrome/navidrome/releases/latest`
- `https://api.github.com/repos/binwiederhier/ntfy/releases/latest`

Workflow:

1. Install Deno locally (binary install), for example:
   `curl -fsSL https://deno.land/install.sh | sh`
2. Ensure `deno` is on `PATH` and verify with `deno --version`
3. Copy or use `config.local.yaml`, then export `NTFY_AUTH_TOKEN` in your environment
4. Start app locally with unstable KV + cron flags and `config.local.yaml`
5. Call `POST /run` once to populate baseline state from live GitHub tag values
6. Confirm no alert is sent on immediate second run (no upstream change)
7. Fake internal state drift by overwriting stored `watch_state` for both watches with old/fake
   values
8. Call `POST /run` again; app should detect difference between fake stored values and live GitHub
   tags
9. Confirm console logs include explicit change detection messages for both watches
10. Confirm ntfy receives alerts for each detected change

Implementation note for step 7:

- Add a small local-only helper script (for tests) that edits KV entries under
  `["watch_state", watch.name]`
- Set `value_hash`/`value` to synthetic old values so next run re-detects current live tags

### Automated tests (minimum)

- Config validation failures (bad cron, duplicate names, missing `auth_env`, invalid URL/protocol,
  invalid retry bounds, ambiguous auth headers)
- JSONPath extraction semantics (0, 1, N matches) including wildcard edge cases
- Canonicalization + hash stability
- No-change vs changed decision behavior
- Notification failure does not advance state (single-attempt per run)
- CAS conflict re-read behavior
- Invalid upstream payload behavior (non-2xx, invalid JSON) and watch isolation
- `/state` endpoint shape and secret safety checks
- Integration test with live GitHub release APIs for `navidrome` and `ntfy` using `$.tag_name`
- Integration test that forces fake prior state and verifies change detection + console alert + ntfy
  notify

## Deployment plan

### Runtime

Deploy to Deno Deploy.

### Files

Repo should include:

- `main.ts`
- `config.yaml`
- `config.local.yaml`
- `deno.json`
- `PLAN.md`
- local test helpers (`fake_api.py`, `fake_ntfy.py` or Deno equivalents)

### Secrets

Configure environment variables in Deno Deploy for:

- `NTFY_AUTH_TOKEN`
- Any upstream API tokens as needed
- Do not set `KV_PATH` on Deploy; use managed Deploy KV via `Deno.openKv()`

### Permissions

Local development should use:

- `--allow-net`
- `--allow-env`
- `--allow-read=.`
- `--allow-write=.` (for local test helper that mutates local KV or test fixtures)
- `--unstable-cron`
- `--unstable-kv`

## Suggested file layout

```text
.
├── main.ts
├── config.yaml
├── config.local.yaml
├── deno.json
├── PLAN.md
├── fake_api.py
└── fake_ntfy.py
```

## Future improvements

- Per-watch source authentication via env vars
- Optional notification templates
- Support multiple notification targets
- Per-watch suppression windows and maintenance windows
- Hash-only mode for very large payload snapshots
- Better structured logs and metrics export
- Support extracting and composing multiple fields per watch
- Optional transformations beyond JSONPath (jq-like)
- UI/dashboard for watch status and recent events

## Implementation sequence

1. Define config schema (including retries, first-run behavior, runtime limits)
2. Implement config loader + strict validation
3. Implement fetch + JSON parse + JSONPath extraction
4. Implement canonicalization + hashing helpers
5. Implement KV state model and read/write helpers
6. Implement change decision logic (first-run/no-change/changed)
7. Implement notifier with idempotency event IDs + single-attempt-per-run semantics
8. Implement atomic write-after-notify and CAS conflict handling
9. Implement lease guard for overlapping runs
10. Add `Deno.cron()` + HTTP endpoints (`/run`, `/health`, `/state`)
11. Add local mocks and automated tests for concurrency/failure cases
12. Add local real-API E2E test flow with forced KV state drift
13. Deploy to Deno Deploy and configure secrets

## Success criteria

The prototype is successful when:

- It runs locally and in Deno Deploy
- It polls configured endpoints on schedule
- It extracts values correctly with JSONPath
- It persists state across runs
- First-run notification behavior is explicit and works as configured
- It emits notifications only on meaningful changes
- It does not advance state if notification fails
- It avoids duplicate notifications across overlapping runs
- Local E2E workflow confirms detection against live GitHub release APIs
- Forced internal state drift causes deterministic re-detection and alerting
- It can be configured through YAML + environment variables
- It stays lightweight enough for free-tier usage

## Implementation decisions (active)

- JSONPath parser is intentionally limited to deterministic single-value paths:
  - `$`
  - `$.foo.bar`
  - array index segments like `$.items[0].name`
  - quoted bracket property segments like `$.releases[0]["tag-name"]`
- JSONPath wildcard is supported for array projections:
  - `$.jobs[*].title`
  - extraction semantics remain: 0 matches -> `null`, 1 match -> scalar, 2+ matches -> list
- Unsupported advanced JSONPath features (unions, recursive descent, filters) fail fast during
  config validation.
- Message auth is env-only via `message.auth_env`.
- Runtime notifier reads notification token from `auth_env` and fails fast if missing.
- Default upstream request header is `accept: application/json` for every watch unless overridden in
  watch/default headers.
- Per-watch upstream auth is supported:
  - `auth_env`: environment variable with token for that watch
  - `auth_prefix`: optional prefix before token (default `Bearer`; use `token` for GitHub)
  - if `auth_env` is set, `headers.authorization` must not also be set for the same watch
- Console alert format for detected change is fixed as:
  - `CHANGE DETECTED [watch-name]`
- Ntfy alert body format is fixed as:
  - `<old_value> -> <new_value>`
  - example: `0.0.0 -> v2.18.0`
- For list-to-list changes, alert body shows a compact diff:
  - `removed: <old-only items>`
  - `added: <new-only items>`
  - items common to old and new are omitted from alert body
- Ntfy alert title is set from the watch name in config.
- Integration tests are split:
  - default local test suite uses mocked upstream/notifier and must always pass offline
  - optional live GitHub E2E test is gated by `RUN_LIVE_TESTS=1`
- Current implementation status:
  - implemented: config loading/validation, canonical hashing, state persistence abstraction,
    notifier, `/run` `/health` `/state`, forced-drift test path
  - runtime note: cron registration occurs before async app initialization; runner/store are lazily
    initialized on first cron/http invocation
  - deferred for next pass: run lease key and bounded-parallel watch execution wiring
