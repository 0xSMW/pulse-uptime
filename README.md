# Pulse Uptime

<img width="870" height="468" alt="image" src="https://github.com/user-attachments/assets/62a8ac06-4e33-4816-8dfb-90f46a0aa4d0" />

Pulse Uptime is a production-grade service for monitoring public HTTP and HTTPS endpoints. It runs entirely on Vercel with a compact dashboard, a stable API, and outage detection that stays correct when scheduled checks overlap, retry, or fail.

## Features

Pulse delivers dependable uptime monitoring for a single team, with web and command-line administration, clear operational visibility, and a deliberately small infrastructure footprint.

- Monitor up to 100 public HTTP and HTTPS endpoints at one, five, ten, or fifteen minute intervals.
- Confirm outages and recoveries with configurable consecutive-result thresholds.
- Send deduplicated outage and recovery email through Resend.
- Review monitor health, response latency, incident history, and a public status page.
- Publish authored status reports with drafts, timeline updates, and affected services, or promote a detected incident into a report.
- Customize the status page name, logos, links, announcement banner, history window, and time zone from Settings or the CLI.
- Manage monitors through the dashboard, the `pulsectl` Go CLI, scoped machine tokens, and the `/api/v1` control plane.
- Run on Vercel with Edge Config for desired configuration and Neon Postgres for durable state and history.

## Getting Started

### Set up the web app

1. Deploy Pulse Uptime to a Vercel Pro project.
2. Connect a Neon Postgres database and a Vercel Edge Config store to the project.
3. Add a Resend API key and a verified sender address for outage and recovery email.
4. Set the generated database and Edge Config values, the public application URL, and secure values for cron, API-token hashing, and CLI device authorization in Vercel.
5. Deploy, then open the application URL. Pulse verifies the deployment, database, Edge Config, and email configuration before continuing.
6. Create the administrator account with an email address and password.
7. Enter the URL and name of the first monitor, confirm the alert recipient, run the initial check, and select **Start Monitoring**.

The dashboard opens with the first monitor active. Add more monitors, notification recipients, API tokens, and status-page settings under **Settings**.

### Set up the CLI

Install the CLI from source with Go until signed release artifacts are published:

```sh
go install github.com/0xSMW/pulse-uptime/cli/cmd/pulsectl@latest
```

Connect it to the deployed service and sign in:

```sh
pulsectl me --server https://pulse.superposition.app
```

The command creates the local context, opens Pulse in a browser, and asks you to link this CLI installation with full administrator access. Confirm the displayed account, installation, permissions, and terminal code, then authorize. The CLI stores the resulting session in the operating-system keyring.

Verify the connection and list the active monitors:

```sh
pulsectl me
pulsectl monitor list
```

For agents, scripts, and CI, create a scoped token under **Settings → API Tokens** and provide it through the environment:

```sh
export PULSECTL_URL=https://pulse.superposition.app
export PULSECTL_TOKEN=pulse_live_...
pulsectl monitor list --output json
```

## Roadmap

Pulse Uptime will grow beyond its single-team HTTP monitoring workflow in these areas:

| Area | Planned direction |
|---|---|
| Multiple users | Invite teammates, assign roles, and manage access without sharing the administrator account. |
| Additional monitor types | Add domain, certificate, port, and content checks alongside HTTP availability. |
| Service and project grouping | Organize related monitors into services and projects for clearer dashboards, incidents, and status pages. |
| Authentication integrations | Sign in with Google and other identity providers, with room for more SSO options as teams grow. |
