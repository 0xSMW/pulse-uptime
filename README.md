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

Pulse Uptime is currently in the architecture and planning stage. You can clone the repository and review the project specification before implementation begins.

1. Clone the repository: `git clone https://github.com/0xSMW/pulse-uptime.git`
2. Enter the project directory: `cd pulse-uptime`
3. Read [`Docs/INIT.md`](Docs/INIT.md) for the complete architecture, requirements, and implementation sequence.
4. Review the supporting design documents and prototype in [`Docs/`](Docs/) for product and interface context.
