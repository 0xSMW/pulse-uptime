# Production Deployment

Pulse runs as one Next.js project on Vercel Pro with a direct Neon project, Vercel Edge Config, Vercel Cron, and Resend.

## 1. Create the Vercel project

Link the repository to the intended Vercel team:

```sh
vercel link --yes --project pulse-uptime --scope <team>
```

Confirm the owner before creating any resources:

```sh
vercel project inspect pulse-uptime --scope <team>
```

## 2. Create Neon directly

```sh
neonctl projects create --name pulse-uptime
neonctl connection-string --project-id <project-id> --pooled
neonctl connection-string --project-id <project-id>
```

Set the pooled URL as `DATABASE_URL` and the direct URL as `DATABASE_URL_UNPOOLED` for Production, Preview, and Development. Apply migrations using the direct URL:

```sh
set -a
source .env.local
set +a
pnpm db:migrate
```

## 3. Create Edge Config

Create an Edge Config named `pulse-uptime` in the same Vercel team. Seed the single `monitoring` key with a valid complete configuration:

```json
{
  "schemaVersion": 1,
  "configVersion": 0,
  "settings": {
    "concurrency": 25,
    "defaultTimeoutMs": 8000,
    "defaultFailureThreshold": 2,
    "defaultRecoveryThreshold": 2,
    "defaultRecipients": [],
    "userAgent": "Pulse/1.0"
  },
  "monitors": []
}
```

Set `EDGE_CONFIG`, `EDGE_CONFIG_ID`, `VERCEL_API_TOKEN`, and `VERCEL_TEAM_ID`. The API token must be authorized to update that Edge Config.

## 4. Configure Resend

Verify the sending domain in Resend, create a sending-only API key, and set:

```text
RESEND_API_KEY
RESEND_FROM_EMAIL=Pulse <alerts@example.com>
```

The readiness screen treats invalid email configuration as a warning and allows setup without alerts. Production validation still requires an actual test message.

## 5. Set application secrets

Generate independent random values of at least 32 bytes for:

```text
CRON_SECRET
API_TOKEN_HASH_KEY
DEVICE_AUTH_SECRET
```

Also set:

```text
NEXT_PUBLIC_APP_URL=https://<production-domain>
NEXT_PUBLIC_STATUS_PAGE_NAME=Pulse
```

The complete canonical environment list is in `.env.example`.

## 6. Deploy and verify

```sh
pnpm verify
vercel deploy --prod --scope <team>
```

After deployment, confirm `/api/v1/version`, `/openapi/v1.json`, `/status`, both authenticated cron routes, onboarding readiness, database migrations, Edge Config acceptance, and Resend delivery before declaring the installation ready.

## 7. Deploy safety: migrate-before-traffic gate

Vercel promotes a production deployment the moment its build finishes, so new code serves before manually applied migrations would run. Code that references a not-yet-added column fails at runtime with SQLSTATE 42703 and takes the crons down. The gate removes the manual step by applying migrations inside the production build, before the artifact that serves traffic is produced.

The build command is `pnpm run vercel-build`, set in `vercel.json`. It runs `node scripts/migrate-deploy.mjs && next build`. The migrate script:

- Migrates only when `VERCEL_ENV=production`. Preview and local builds log a skip and exit 0, so they never touch the production database.
- Uses `DATABASE_URL_UNPOOLED` (the direct, non-pooled Neon connection). A pooled URL is refused, not used as a fallback, because advisory locks and DDL are session scoped and unreliable over the pooler.
- Serializes overlapping builds with a Postgres advisory lock (`pg_try_advisory_lock`, bounded wait). Two builds cannot corrupt the drizzle journal. The second waits, then finds no pending migrations and no-ops.
- Fails the build loudly on any migration error, so the previous deployment keeps serving.

Required Vercel setting: `DATABASE_URL_UNPOOLED` must be present in the Production environment. Add the direct Neon connection string to Production in project settings, or `vercel env add DATABASE_URL_UNPOOLED production`. Without it the production build fails fast at the migrate step.

### Expand, migrate, contract

Schema changes ship in additive steps so no deployment ever reads a column that does not yet exist.

- Additive migrations (new nullable columns, new tables, new indexes) ship ahead of or together with the code that reads them. The gate applies them before the reader serves traffic.
- Destructive migrations (dropping or renaming a column, tightening a constraint) ship only after all code that reads the old shape is gone. Deploy the reader change first, let it go live, then ship the drop in a later deployment.

## 8. Deploy safety: cron canary

`.github/workflows/deploy-canary.yml` runs on GitHub `deployment_status` events (Vercel creates GitHub deployments for this repo). When a Production deployment reaches `success`, the workflow invokes `/api/cron/check-monitors` and `/api/cron/check-dependencies` once each with the `CRON_SECRET` bearer and asserts each returns status `completed` or `duplicate`. A `failed` status or a persistent non-200 fails the workflow (red X on the commit) and posts a commit comment naming the failing cron and its response.

The canary targets the public production alias via the `PRODUCTION_URL` secret, not the immutable per-deployment URL, because that URL is behind Vercel deployment protection and returns an SSO redirect. Required GitHub Actions secrets: `CRON_SECRET` and `PRODUCTION_URL`.
