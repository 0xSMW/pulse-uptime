# Contributing to Pulse Uptime

## Local setup

Pulse requires Node.js 22 or newer, pnpm 10, Go 1.26, Neon Postgres, and a Vercel Edge Config connection.

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm db:migrate
pnpm dev
```

Build the CLI from `cli/`:

```sh
cd cli
go test -race ./...
go build ./cmd/pulsectl
```

## Verification

Before opening a pull request, run:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
(cd cli && go test -race ./... && go vet ./...)
```

Test web behavior only through the running application in the in-app browser.

## Pull requests

- Keep changes focused and explain the user-visible behavior.
- Include regression tests for fixes and new domain behavior.
- Preserve the reliability, SSRF, idempotency, and credential-storage invariants in `Docs/INIT.md`.
- Update OpenAPI whenever `/api/v1` behavior changes.
- Never commit credentials, local environment files, database URLs, or generated CLI tokens.
