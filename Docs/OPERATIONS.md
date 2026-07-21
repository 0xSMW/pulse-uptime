# Operations Guide

## Routine health

Check these signals together:

- Dashboard health banner and latest check timestamps
- `/api/v1/status` using an authenticated principal
- `cron_runs` for the latest `monitor-check` and `maintenance` executions
- `job_leases` for leases older than 90 seconds
- `notification_outbox` for retrying, dead, or stale `sending` rows
- Accepted versus rejected rows in `monitoring_config_snapshots`

Never infer service health from a successful Vercel deployment alone.

## Monitoring cron

`/api/cron/check-monitors` runs each minute. It acquires the `monitor-check` lease, resolves an accepted configuration, reconciles and delivers notifications, dispatches due monitors, records transitions, and finalizes its run.

If a run fails:

1. Inspect the matching structured `cron.failed` event, `cron_runs.error_message`, and `cron_runs.error_detail`.
2. Confirm the last accepted configuration still exists in Postgres.
3. Check Edge Config validity without replacing the accepted snapshot.
4. Confirm Neon connectivity and lease expiry.
5. Invoke the cron route once with `Authorization: Bearer $CRON_SECRET` after correcting the cause.

### Recorded failure detail

Every failed run stores the full fault in `cron_runs.error_detail` (jsonb) alongside the single-line `error_message`. The capture holds the message, the Postgres `code`, `detail`, `hint`, `severity`, `constraint`, `table`, `column`, `schema`, and `routine`, and the wrapped cause chain. It is bounded at 16 KB and sets `"truncated": true` when any field or cause was dropped to fit. Read `error_detail` first, it names the real fault where `error_message` only summarizes it.

### Loop failure detection and self-alerting

The monitoring loop reports its own health so a silent stop can never again go unseen.

- The dashboard health banner and the Settings, System screen raise `MONITORING_STALE` when no `monitor-check` run has completed within three minutes, and `MONITORING_FAILING` when the last three terminal runs all failed. Either warning means the loop is broken the moment anyone opens the dashboard.
- The sweep cron runs every ten minutes on a schedule separate from the per-minute loop and survived the incident that motivated this. It cross-checks `monitor-check` from `cron_runs`. When the loop is stale beyond five minutes or its recent runs are all failing, it enqueues a `system.alert` into the outbox and, because the outbox drainer rides the same broken loop, sends that same mail directly through the email transport in the same pass.
- Alert recipients are the accepted configuration default recipients. Delivery is deduplicated to one mail per hour per recipient through the outbox idempotency key, so a persistent fault does not mail every ten minutes.

Honest limits. If no default recipients are configured, no mail can send and only the dashboard surfaces the fault. The sweep alert still runs inside the same Vercel project, so a total deployment outage or a stopped Vercel cron scheduler defeats it. Cover that gap with the external dead-mans-switch below.

### External dead-mans-switch (operator setup)

The in-process alert cannot fire if the whole deployment is down. Add an independent outside heartbeat as the outer net.

1. Create a check on an external service Pulse does not depend on (for example Healthchecks.io, Better Stack, or an external cron ping).
2. Point it at the public `GET /api/health` endpoint on a two to three minute cadence. It answers `{ "app": "ok", "database": "ok" }` without authentication.
3. Configure that service to alert you when the endpoint stops responding or reports `"database": "unreachable"`.

This is deliberately a separate operator-owned dependency rather than a built-in one, so Pulse never relies on itself to prove it is alive.

## Cold starts and keep-warm

No keep-warm job runs, and none is needed. The `check-monitors` and `check-dependencies` crons fire every minute, so Neon receives a query roughly every sixty seconds around the clock. That traffic keeps the compute active well inside its idle-suspend window, so there is no cold Neon to warm and a dedicated keep-warm cron would only add a redundant per-minute query.

The real cold-start surface is the serverless function itself, not the database. A cron invocation into an idle Vercel function pays the usual Node start and module-load cost on its first request. This is inherent to serverless scheduling, is a small fixed cost against the per-minute cadence and the sixty second `maxDuration`, and is not something a keep-warm query would remove. If a specific route's cold start ever matters, address it at the function level (bundle size, lazy imports) rather than by pinging the database.

## Notification delivery

Outbox rows are claimed atomically. A five-minute stale claim is retried with the same permanent incident/event/recipient key while the provider idempotency window remains safe. Ambiguous sends older than that window become `dead` to prevent duplicate delivery.

For a dead row, determine whether Resend accepted the message before retrying manually. Never change its idempotency key.

## Publishing a status report during an outage

Detected incidents and authored reports coexist. Promotion always creates a draft; nothing reaches the public status page until you publish.

From the dashboard:

1. Open **Incidents → Outage history** and choose **Write report** on the incident row.
2. Edit the draft: title, affected services and impact, and the first update.
3. Select **Publish**. Updates appear on the status page immediately.

From the CLI:

```sh
pulsectl incident promote inc_123        # creates a draft report from the incident
pulsectl report publish rep_456
pulsectl report post rep_456 --status monitoring --message "A fix is deployed; watching recovery."
pulsectl report resolve rep_456
```

`report resolve` posts the closing update with the body "Resolved." for incidents or "Completed." for maintenance unless `--message` is given. For longer updates, read the body from stdin:

```sh
pulsectl report post rep_456 --status identified --message-file - <<'EOF'
The connection pool was exhausted by a runaway deploy.
We are rolling back and restoring capacity.
EOF
```

Report commands require the `reports:read` and `reports:write` scopes. Credentials minted before these scopes existed lack them — re-run `pulsectl auth login` or create a new token.

## Configuration recovery

Edge Config is desired state. The last accepted Postgres snapshot remains executable during invalid, destructive-unapproved, or temporarily unavailable Edge Config reads.

For a rejected candidate:

1. Inspect `rejection_reason` and the target semantic hash.
2. Correct the complete configuration or create the required exact-hash approval.
3. Allow the next monitoring run to accept and synchronize it.
4. Confirm registry, state, snapshot, and `config_operations` convergence.

## Database maintenance

Daily maintenance recalculates recent UTC rollups, reconciles stale work, expires authorization and idempotency records, and deletes retention data in bounded batches. Investigate a growing backlog before changing retention limits.

Run migrations only through `DATABASE_URL_UNPOOLED`. Runtime functions use the pooled `DATABASE_URL`.

## Credential response

- Revoke API tokens from Settings or `/api/v1/tokens/{tokenId}`.
- Revoke a CLI installation to invalidate every linked CLI session.
- Password change revokes every human session including the current one and clears the session cookie so the operator must sign in again.
- Rotate `API_TOKEN_HASH_KEY` or `DEVICE_AUTH_SECRET` only with an explicit credential invalidation plan.
- Rotate `CRON_SECRET`, the Resend key, Neon credentials, and the Vercel API token in both Vercel and the provider.

## Recovering from admin lockout

Changing the account email revokes every other dashboard session. Changing the password revokes every human session including the current one and returns `reauthenticate: true` with a cleared session cookie. Concurrent email or password changes that lose the credential compare-and-swap return 409 ACCOUNT_CHANGED. The email address is the sole login identifier, and there is no reset-by-email flow. A mistyped email during an email change therefore locks the dashboard.

Machine credentials are deliberately not revoked by these changes: existing API tokens and CLI sessions keep working, so `pulsectl` remains available while the dashboard is locked.

There is no in-app credential reset. Recovery re-opens onboarding, and reclaiming the install requires the setup token, so before deleting anything confirm `PULSE_BOOTSTRAP_TOKEN` is set in the deployment environment and that you know its value. If it was removed after initial setup, set a new value of at least 16 characters and redeploy first. Account creation refuses while an administrator row exists, so remove the account rows directly in Postgres. `human_sessions` and `onboarding_progress` reference `admin_users` without cascading deletes, so delete them first:

```sql
begin;
delete from human_sessions;
delete from onboarding_progress;
delete from admin_users;
commit;
```

Then open the application URL. With no administrator row, onboarding runs again. Account creation (`createOnlyAdmin` in `lib/auth/service.ts`) verifies the setup token before the admin and readiness checks, then requires `hasAdmin()` to return false and the readiness checks (Vercel, database, Edge Config, and email) to pass. The expected token is the `PULSE_BOOTSTRAP_TOKEN` environment variable, and the onboarding form asks for it in the Setup Token field (the API accepts it as the `x-pulse-bootstrap-token` header or the `bootstrapToken` body field). Verification fails closed. If the variable is unset or shorter than 16 characters, every attempt returns 403 `BOOTSTRAP_REQUIRED` and the install cannot be claimed at all, which is why the token must be in place before you delete the account rows. Because the claim requires this operator-held token, an unclaimed install is not open to whoever reaches the URL first, but still run the SQL and create the account promptly rather than leaving the install unclaimed. Create the account with the correct email and a new password. If you set a temporary token for this recovery, remove it from the environment afterward. Monitors, incidents, configuration, and history are untouched. Only the account, its sessions, and onboarding progress are recreated.

