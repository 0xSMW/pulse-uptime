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

1. Inspect the matching structured `cron.failed` event and `cron_runs.error_message`.
2. Confirm the last accepted configuration still exists in Postgres.
3. Check Edge Config validity without replacing the accepted snapshot.
4. Confirm Neon connectivity and lease expiry.
5. Invoke the cron route once with `Authorization: Bearer $CRON_SECRET` after correcting the cause.

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
- Revoke human sessions after a password change.
- Rotate `API_TOKEN_HASH_KEY` or `DEVICE_AUTH_SECRET` only with an explicit credential invalidation plan.
- Rotate `CRON_SECRET`, the Resend key, Neon credentials, and the Vercel API token in both Vercel and the provider.

## Recovering from admin lockout

Changing the account email or password revokes every other dashboard session, and the email address is the sole login identifier — there is no reset-by-email flow. A mistyped email during an email change therefore locks the dashboard.

Machine credentials are deliberately not revoked by these changes: existing API tokens and CLI sessions keep working, so `pulsectl` remains available while the dashboard is locked.

There is no in-app credential reset. Recovery re-opens onboarding: account creation refuses while an administrator row exists, so remove the account rows directly in Postgres. `human_sessions` and `onboarding_progress` reference `admin_users` without cascading deletes, so delete them first:

```sql
begin;
delete from human_sessions;
delete from onboarding_progress;
delete from admin_users;
commit;
```

Then open the application URL. With no administrator row, onboarding runs again; the account step is gated by the deployment's `PULSE_BOOTSTRAP_TOKEN`, so only an operator with access to the environment can claim the install. Create the account with the correct email and a new password. Monitors, incidents, configuration, and history are untouched — only the account, its sessions, and onboarding progress are recreated.

