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

After deployment, confirm `/api/v1/version`, `/openapi/v1.json`, `/status`, both authenticated cron routes, onboarding readiness, database migrations, Edge Config acceptance, and Resend delivery. Finish the production checklist in `Docs/INIT.md` before declaring the installation ready.

