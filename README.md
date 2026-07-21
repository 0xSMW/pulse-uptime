# Pulse Uptime

<img width="1077" height="854" alt="image" src="https://github.com/user-attachments/assets/4f4e48da-eb1c-49a7-a9f5-a70e408c4c97" />

Pulse Uptime is a production-grade service for monitoring public HTTP and HTTPS endpoints. It runs entirely on Vercel with a compact dashboard, a stable API, and outage detection that stays correct when scheduled checks overlap, retry, or fail.

## Features

Pulse delivers dependable uptime monitoring for a single team, with web and command-line administration, clear operational visibility, and a deliberately small infrastructure footprint.

- Monitor up to 100 public HTTP and HTTPS endpoints at one, five, ten, or fifteen minute intervals.
- Confirm outages and recoveries with configurable consecutive-result thresholds.
- Add third-party dependencies (OpenAI, Vercel, Stripe, Neon, and more) and see each provider's officially reported status beside your own checks, with incident overlap context.
- Watch new monitors move through a verified setup phase, then unlock the 24-hour, 7-day, and 30-day ranges as real history accrues, with a live-updating detail page.
- Send deduplicated outage and recovery email through Resend.
- Review monitor health, response latency, check coverage, incident history, and a public status page.
- Publish authored status reports with drafts, timeline updates, and affected services, or promote a detected incident into a report.
- Customize the status page name, logos, links, announcement banner, history window, and time zone from Settings or the CLI.
- Work from the terminal with `pulsectl`, a CLI polished for humans and fully scriptable for agents, with JSON output on every command.
- Automate anything through the `/api/v1` control plane, a REST API with an OpenAPI specification, idempotency keys, and ETag concurrency across monitors, dependencies, reports, and status page configuration.
- Grant agents, scripts, and CI least-privilege access with scoped machine tokens.
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

## OpenAI Build Week

Codex and GPT-5.6 were my engineering counterparts on this project. It started with GPT-5.6 in ChatGPT, where I talked through what I wanted and sharpened those ideas into a plan spec, researching how to stay within the boundaries of Vercel capabilities I was not used to, and how to shape a small database footprint so anyone could run a free version. Once I had a plan I was confident in, I brought it to Codex, started a new project, and ran GPT-5.6 on high to manage a swarm of agents that built it out. With the app up and running, I used Codex for a series of sweeps through the codebase for security and performance. I was responsible for the ideas, the shaping, and the design. Codex handled the rest.

I started the project on Saturday morning and finished the submission on the 21st. By the end of Saturday, the entire scope of the project was finished. Sunday and Monday were completely occupied, first with the security hardening, and then with cleanup and polish. The first 80% took four to six hours, and the final 20% took over two days.

## Roadmap

Pulse Uptime will grow beyond its single-team HTTP monitoring workflow in these areas:

| Area | Planned direction |
|---|---|
| Multiple users | Invite teammates, assign roles, and manage access without sharing the administrator account. |
| Additional monitor types | Add domain, certificate, port, and content checks alongside HTTP availability. |
| Authentication integrations | Sign in with Google and other identity providers, with room for more SSO options as teams grow. |
