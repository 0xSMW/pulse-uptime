# Pulse Uptime

## Overview

Pulse Uptime is a planned production-grade service for monitoring public HTTP and HTTPS endpoints. It is designed to run entirely on Vercel, with a compact dashboard, a stable API, and reliable outage detection that remains correct when scheduled jobs overlap, retry, or fail.

## Features

The first release focuses on dependable uptime monitoring for a single team, with web and command-line administration, clear operational visibility, and a deliberately small infrastructure footprint.

- Monitor up to 100 public HTTP and HTTPS endpoints at one-, five-, ten-, or fifteen-minute intervals.
- Confirm outages and recoveries with configurable consecutive-result thresholds.
- Send deduplicated outage and recovery notifications through Resend email.
- Review monitor health, response latency, incident history, and a public status page.
- Manage monitors through the dashboard, a Go CLI, scoped machine tokens, and the `/api/v1` control plane.
- Run on Vercel with Edge Config for desired configuration and Neon Postgres for durable state and history.

## Getting Started

### Set up the web app

1. Deploy Pulse Uptime to a Vercel Pro project.
2. Connect a Neon Postgres database and a Vercel Edge Config store to the project.
3. Add a Resend API key and verified sender address for outage and recovery email.
4. Configure the generated database and Edge Config values, the public application URL, and secure values for cron, API-token hashing, and CLI device authorization in Vercel.
5. Deploy, then open the application URL. Pulse checks the deployment, database, Edge Config, and email configuration before continuing.
6. Create the administrator account with an email address and password.
7. Enter the URL and name of the first monitor, confirm the alert recipient, run the initial check, and select **Start Monitoring**.

The dashboard opens with the first monitor active. Additional monitors, notification recipients, API tokens, and status-page settings are available under **Settings**.

### Set up the CLI

Install the CLI from source with Go (until signed release artifacts are published):

```sh
go install github.com/productos-ai/pulse-uptime/cli/cmd/pulsectl@latest
```

Connect it to the deployed service and sign in:

```sh
pulsectl me --server https://pulse.example.com
```

The command creates the local context, opens Pulse in a browser, and asks you to link this CLI installation with full administrator access. Confirm the displayed account, installation, permissions, and terminal code, then authorize. The CLI stores the resulting session in the operating-system keyring.

Verify the connection and list the active monitors:

```sh
pulsectl me
pulsectl monitor list
```

For agents, scripts, and CI, create a scoped token under **Settings → API Tokens** and provide it through the environment:

```sh
export PULSECTL_URL=https://pulse.example.com
export PULSECTL_TOKEN=pulse_live_...
pulsectl monitor list --output json
```

## Roadmap

Pulse Uptime will expand beyond its initial single-team HTTP monitoring workflow in these areas:

| Area | Planned direction |
|---|---|
| Multiple users | Invite teammates, assign roles, and manage access without sharing the administrator account. |
| Additional monitor types | Monitor more than HTTP availability, including domains, certificates, ports, and content checks. |
| Service and project grouping | Organize related monitors into services and projects for clearer dashboards, incidents, and status pages. |
| Authentication integrations | Sign in with Google and other identity providers, with room for additional SSO options as teams grow. |
