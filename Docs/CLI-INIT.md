# Uptime Service CLI — Engineering Architecture and Product Specification

## Decision

Build the CLI in Go as a thin client over the service’s stable `/api/v1` control plane.

Go is the best fit because the product needs one compact binary across macOS, Linux, and Windows, low-friction cross-compilation, mature command tooling, and predictable scripting behavior. Swift would provide a strong macOS-native development experience, though cross-platform packaging and release operations would carry more platform-specific work.

Use Cobra for command parsing and documentation generation. Use static line-oriented output for ordinary commands. Avoid a full-screen TUI in v1.

Use `pulsectl` as the product binary name.

## Product objective

| User | Required experience |
|---|---|
| Human operator | Clear tables, browser login, concise errors, confirmations, completion, optional color |
| Coding agent | Complete command discovery, stable JSON, deterministic behavior, stdin, no surprise prompts |
| Shell script | Stable exit codes, JSON/TSV, environment authentication, safe retries |
| CI system | Noninteractive operation, scoped tokens, no ANSI output, explicit deadlines |
| Infrastructure workflow | Complete config export, validation, stateless plan, and apply |

The CLI never connects directly to Neon, Edge Config, Resend, or Vercel management APIs.

## Core principles

| Principle | Requirement |
|---|---|
| API-first | Every action maps to `/api/v1` |
| Complete discovery | No-argument help prints every leaf command |
| Machine grammar | JSON help describes arguments, flags, examples, input, and output |
| Stable automation | Machine formats use versioned schemas |
| Deterministic behavior | Stable sorting, timestamps, field names, and exit codes |
| Explicit mutation | Destructive actions require interactive confirmation or explicit flags |
| Thin client | Server remains authoritative for validation and mutation |
| Safe retries | Every mutation carries one persistent idempotency key |
| Composable input | Flags, files, environment variables, and stdin |
| Output discipline | Data on stdout; diagnostics and progress on stderr |
| Cross-platform | First-class macOS, Linux, and Windows binaries |

## Architecture

```text
┌──────────────────────────────────────────────────────┐
│                    Human or agent                    │
└──────────────────────────┬───────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────┐
│                    pulsectl                        │
│                                                      │
│ Cobra commands                                       │
│ Context and credential management                    │
│ Human and machine renderers                          │
│ Generated OpenAPI client models                      │
│ Retry and idempotency handling                       │
│ Declarative export / validate / plan / apply         │
└──────────────────────────┬───────────────────────────┘
                           │ HTTPS
                           │ Bearer token
                           │ Idempotency-Key
                           │ If-Match for config apply
                           ▼
┌──────────────────────────────────────────────────────┐
│                   Service /api/v1                    │
│                                                      │
│ Authentication and scopes                            │
│ Validation and idempotency                           │
│ Config planning and serialized apply                 │
│ Monitor and incident operations                      │
└──────────────────────────────────────────────────────┘
```

## Technology selection

| Concern | Selection |
|---|---|
| Language | Current stable Go |
| Command framework | Cobra |
| HTTP | Go standard `net/http` |
| API models | Generated from OpenAPI |
| OpenAPI generator | `oapi-codegen` or equivalent |
| YAML | `gopkg.in/yaml.v3` |
| Keyring | `github.com/zalando/go-keyring` |
| Terminal detection | `golang.org/x/term` |
| Static styling | Lip Gloss or a small internal renderer |
| Tables | Internal width-aware renderer |
| UUID | `google/uuid` or equivalent |
| Testing | Standard Go tests, golden files, `httptest` |
| Releases | GoReleaser through GitHub Actions |
| Documentation | Generated from Cobra command tree |

Use `zalando/go-keyring` explicitly. The release matrix must prove `CGO_ENABLED=0` builds work for every target, including Windows ARM64.

## Repository structure

```text
cli/
  cmd/
    pulsectl/
      main.go

  internal/
    api/
      client.gen.go
      client.go
      errors.go
      retry.go
      transport.go

    auth/
      device.go
      credentials.go
      installation.go
      keyring.go
      token.go

    command/
      root.go
      me/
      auth/
      context/
      token/
      monitor/
      incident/
      config/
      notification/
      status/
      completion/
      doctor/
      version/

    config/
      file.go
      paths.go
      precedence.go
      context.go

    input/
      duration.go
      status_range.go
      recipients.go
      document.go

    output/
      renderer.go
      table.go
      json.go
      jsonl.go
      yaml.go
      tsv.go
      error.go
      color.go
      terminal.go

    manifest/
      commands.go
      schema.go

    signals/
      cancel.go

    buildinfo/
      version.go

  openapi/
    service.openapi.yaml

  docs/
    commands/

  tests/
    golden/
    fixtures/
    integration/
    agent-contract/

  .goreleaser.yaml
  go.mod
  go.sum
  README.md
```

## Command surface

```text
pulsectl

  me

  auth login
  auth logout
  auth status

  context add
  context list
  context show
  context use
  context remove

  token create
  token list
  token revoke

  group list
  group create
  group rename
  group delete

  monitor list
  monitor get
  monitor create
  monitor update
  monitor pause
  monitor resume
  monitor delete
  monitor test
  monitor watch

  incident list
  incident get
  incident promote

  report list
  report get
  report create
  report update
  report post
  report edit-update
  report delete
  report resolve
  report publish

  status-page get
  status-page set
  status-page export
  status-page apply

  config export
  config validate
  config plan
  config apply
  config schema

  notification test

  status
  doctor
  completion
  version
  help
```

Keep the hierarchy shallow and canonical. Aliases may improve human ergonomics, though generated machine help exposes canonical paths only.

## Default help contract

These commands print the complete root help and exit zero:

```text
pulsectl
pulsectl help
pulsectl --help
pulsectl -h
```

The root help must show every leaf command, global flag, stable environment variable, and five representative examples. Keep it under approximately 100 lines.

Detailed help:

```text
pulsectl help monitor create
pulsectl monitor create --help
```

## Machine-readable help

```text
pulsectl help --output json
```

Example shape:

```json
{
  "schemaVersion": 1,
  "binary": "pulsectl",
  "version": "1.0.0",
  "commands": [
    {
      "path": ["monitor", "create"],
      "summary": "Create a monitor",
      "arguments": [],
      "flags": [
        {
          "name": "id",
          "type": "string",
          "required": true
        }
      ],
      "supportsStdin": false,
      "supportsOutput": ["table", "json", "yaml"],
      "examples": []
    }
  ]
}
```

Generate this manifest from the Cobra command tree. CI fails when the manifest, Markdown docs, and implementation diverge.

## Stable environment variables

Use a CLI-specific prefix from the first public build:

```text
PULSECTL_CONTEXT
PULSECTL_URL
PULSECTL_TOKEN
PULSECTL_OUTPUT
PULSECTL_TIMEOUT
NO_COLOR
```

Use `PULSECTL_` as the permanent product prefix. Do not publish generic `MONITOR_*` variables.

## Configuration precedence

```text
Command flag
Environment variable
Active context configuration
Built-in default
```

Authentication precedence:

```text
PULSECTL_TOKEN
Token supplied through stdin for the current command
Operating-system keyring credential
```

Do not implement a global `--token` flag because arguments can appear in shell history and process listings.

## Local configuration

Use `os.UserConfigDir()`.

```text
macOS:
~/Library/Application Support/pulsectl/config.yaml

Linux:
~/.config/pulsectl/config.yaml

Windows:
%AppData%\pulsectl\config.yaml
```

Non-secret context file:

```yaml
version: 1
installation:
  id: ins_local_7ce8b54f
  name: Stephen’s Mac
currentContext: production

contexts:
  production:
    server: https://pulse.example.com
    output: table
    timeout: 15s

  local:
    server: http://localhost:3000
    output: json
    timeout: 30s
```

Human session credentials live in the operating-system keyring, indexed by normalized service URL and identity. Agent tokens normally enter through `PULSECTL_TOKEN`.

When an environment token is present, never write it to disk.

## Authentication

Support two paths:

| Path | Intended user |
|---|---|
| Browser device authorization | Human operator |
| Scoped bearer token | Agent, script, or CI |

### Installation identity

On first run, generate a random installation ID and store it in the non-secret local configuration. Give it a human-readable default name derived from the device, such as `Stephen’s Mac`, and send the ID, name, CLI version, platform, and architecture with device authorization. Never derive identity from a hostname alone.

The service links the installation to the administrator only after browser approval. Human CLI credentials live in the operating-system keyring under service name `pulsectl`, keyed by normalized server URL and installation ID. Revoking an installation revokes all of its CLI sessions.

### `me` command

`pulsectl me` is the preferred human entrypoint and an authentication passthrough.

```text
pulsectl me --server https://pulse.example.com
```

Behavior:

- Resolve the server from `--server`, `PULSECTL_URL`, or the active context, in that order.
- When `--server` supplies a new server, create and activate a context derived from its hostname before authorization.
- If a valid human session exists, call `GET /api/v1/me` and print the linked account, installation, server, and full-access status.
- If no human session exists and stdin is a terminal, start the same browser-linking flow as `pulsectl auth login`, store the approved credential, then call `GET /api/v1/me` and print the result.
- If `PULSECTL_TOKEN` is present, act as a pure authenticated passthrough to `GET /api/v1/me`; never launch a browser or write that token to disk.
- In noninteractive mode without a valid credential, return exit 7 with an exact authentication-required error. Never launch a browser or prompt.
- `--no-browser` prints the verification URL and user code, then continues standards-compliant polling.

Human output:

```text
operator@example.com
Installation  Stephen’s Mac
Server        https://pulse.example.com
Access        Full access
```

Machine output uses this versioned object:

```json
{
  "apiVersion": "v1",
  "kind": "Me",
  "data": {
    "principalType": "cli_session",
    "email": "operator@example.com",
    "tokenName": null,
    "server": "https://pulse.example.com",
    "scopes": ["monitors:read", "monitors:write", "incidents:read", "config:read", "config:write", "notifications:test", "tokens:manage", "status:read", "reports:read", "reports:write"],
    "installation": {
      "id": "ins_01J...",
      "name": "Stephen’s Mac",
      "platform": "darwin",
      "arch": "arm64",
      "linkedAt": "2026-07-18T04:00:00Z"
    }
  }
}
```

### Human login and installation linking

```text
pulsectl auth login
```

`pulsectl auth login` delegates to the same installation-linking flow as `pulsectl me`. It forces reauthorization when `--reauthorize` is present; otherwise it reuses a valid linked session.

Flow:

```text
Generate or load the local installation ID
Request full-access device authorization
Print user code and verification URL
Open browser unless --no-browser
Show the signed-in Pulse account, installation identity, and complete permission summary
Approve or cancel in Pulse
Poll token endpoint at server interval
Handle pending, slow-down, denial, and expiry states
Link the installation and store the issued CLI session token in keyring
```

Example:

```text
Opening https://pulse.example.com/cli/authorize

Enter code: H7KD-PQ4M

Waiting for approval...
Linked Stephen’s Mac to operator@example.com
Context production is ready.
```

The human authorization page has no scope picker. Approval grants the CLI session every administrator scope available in v1:

```text
monitors:read
monitors:write
incidents:read
config:read
config:write
notifications:test
tokens:manage
status:read
reports:read
reports:write
```

The page groups these into plain-language permissions, displays the exact account and installation, and requires an explicit **Authorize** action. **Cancel** denies the request. Approval stores a named scope profile (`administrator`) on the session, not a scope snapshot. The profile resolves to the live scope list at auth time, so scopes introduced in later releases apply to existing sessions automatically without reauthorization. Manually minted API tokens are different: they keep the exact scope snapshot granted at mint time.

Polling behavior follows these server errors:

| Error | CLI behavior |
|---|---|
| `authorization_pending` | Continue at current interval |
| `slow_down` | Add five seconds to current interval |
| `access_denied` | Stop and exit 7 |
| `expired_token` | Stop and exit 3 |

The CLI must honor the server-supplied interval and device-code expiration.

CLI session tokens have no refresh token in v1. Expiration or revocation causes the next interactive `pulsectl me` or `pulsectl auth login` to restart installation linking.

### Agent tokens

```text
pulsectl token create \
  --name deployment-agent \
  --scope monitors:read \
  --scope monitors:write \
  --scope incidents:read \
  --expires-in 90d
```

The secret is shown once. Machine output may include it only in the token-creation response.

`--expires-in` defaults to 90 days and may not exceed 365 days. V1 has no `--no-expiry` option. When the caller is itself a token, the requested expiry may not exceed the caller’s remaining lifetime.

Token creation requires `tokens:manage`. Requested scopes must be a subset of the caller’s effective scopes; the CLI may reject an obvious local violation, and the server enforces the rule authoritatively.

Supported scopes:

```text
monitors:read
monitors:write
incidents:read
config:read
config:write
notifications:test
tokens:manage
status:read
reports:read
reports:write
```

## Service API

The CLI calls only:

```text
/api/v1
```

Canonical OpenAPI source:

```text
openapi/service.openapi.yaml
```

Required endpoints:

```text
GET    /api/v1/version
GET    /api/v1/me

GET    /api/v1/groups
POST   /api/v1/groups
PATCH  /api/v1/groups/{groupId}
DELETE /api/v1/groups/{groupId}

GET    /api/v1/monitors
POST   /api/v1/monitors
GET    /api/v1/monitors/{monitorId}
PATCH  /api/v1/monitors/{monitorId}
DELETE /api/v1/monitors/{monitorId}
POST   /api/v1/monitors/{monitorId}/pause
POST   /api/v1/monitors/{monitorId}/resume
POST   /api/v1/monitors/{monitorId}/test

GET    /api/v1/incidents
GET    /api/v1/incidents/{incidentId}
GET    /api/v1/status

GET    /api/v1/config
GET    /api/v1/config/schema
POST   /api/v1/config/validate
POST   /api/v1/config/plan
POST   /api/v1/config/apply
GET    /api/v1/config/operations/{operationId}

POST   /api/v1/notifications/test

POST   /api/v1/tokens
GET    /api/v1/tokens
DELETE /api/v1/tokens/{tokenId}

POST   /api/v1/cli-auth/device
POST   /api/v1/cli-auth/token
POST   /api/v1/cli-auth/revoke
```

## Request contract

Every request includes:

```http
Authorization: Bearer <token>
User-Agent: pulsectl/1.0.0 (darwin; arm64)
Accept: application/json
X-Request-ID: <uuid>
```

Every mutation includes:

```http
Idempotency-Key: <uuid>
```

Config apply includes:

```http
If-Match: "<base-config-hash>"
```

The CLI generates one idempotency UUID before the first attempt and reuses it for every retry.

The request body’s `baseConfigHash` is authoritative. The CLI must send the same value in `If-Match`; it must treat `PRECONDITION_MISMATCH` as invalid client construction and `CONFIG_VERSION_CONFLICT` as a re-plan requirement.

## Response contract

Object:

```json
{
  "apiVersion": "v1",
  "kind": "Monitor",
  "data": {},
  "meta": {
    "requestId": "req_..."
  }
}
```

Error:

```json
{
  "apiVersion": "v1",
  "kind": "Error",
  "error": {
    "code": "CONFIG_VERSION_CONFLICT",
    "message": "Configuration changed before the update was applied.",
    "details": {},
    "requestId": "req_..."
  }
}
```

Agents branch on `error.code` rather than message text.

## Output formats

```text
--output table
--output json
--output jsonl
--output yaml
--output tsv
```

### Default output selection

| Command context | Default |
|---|---|
| Ordinary command, stdout attached to terminal | `table` |
| Ordinary command, stdout redirected or piped | `json` |
| `monitor watch`, stdout attached to terminal | Dynamic table |
| `monitor watch`, stdout redirected | `jsonl` |
| `config export` | `yaml` in both terminals and pipes |
| `config schema` | `json` in both terminals and pipes |

`config export` is an explicit exception to the general redirected-output JSON default.

Machine output contains:

- No ANSI sequences.
- No spinner frames.
- No relative timestamps.
- No surrounding prose.
- No progress updates.
- No terminal hyperlinks.
- No truncated fields.

All diagnostics and progress go to stderr.

## Machine-output pagination

List commands auto-paginate to completion when machine output is selected and `--limit` is absent.

Rules:

- `--limit` caps the total returned records, not one server page.
- `--cursor` begins at the requested cursor.
- Table output may use a practical default limit and print a continuation hint.
- `--all` forces full pagination for human table output.
- JSON output returns one complete list document after pagination.
- JSONL may emit records as pages arrive, followed by no summary prose.
- Stable server ordering must be preserved across pages.

## JSON stability

Every machine structure contains `apiVersion` and `kind`.

| Change | Policy |
|---|---|
| Add optional field | Allowed in current API version |
| Add enum value | Clients preserve unknown values |
| Remove or rename field | New API version |
| Change field type | New API version |
| Change command meaning | New CLI major version |
| Add command or optional flag | Minor version |
| Rendering fix | Patch version |

Commit JSON Schema fixtures for every machine-output shape.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Command completed successfully |
| 1 | Unexpected CLI failure |
| 2 | Invalid arguments or input |
| 3 | Authentication required, expired, or invalid |
| 4 | Requested operational condition failed |
| 5 | Resource not found |
| 6 | Version, state, or configuration conflict |
| 7 | Permission denied or device authorization denied |
| 8 | Rate limited |
| 9 | Service unavailable or network failure |
| 10 | Partial success |
| 130 | Interrupted by SIGINT |

Read commands return zero when retrieval succeeds, even when monitors are down. Operational assertion flags opt into code 4.

## Signal behavior

On SIGINT:

- Cancel the active request or watch loop through context cancellation.
- Stop polling without printing another machine record.
- Restore terminal state.
- Print at most one concise interruption message to stderr in human mode.
- Exit 130.

On SIGTERM:

- Perform the same cleanup.
- Exit 143 where the platform permits, otherwise return a documented generic termination code.

## Timeout model

Global `--timeout` and `PULSECTL_TIMEOUT` define the deadline for each individual HTTP request attempt.

They do not define the complete duration of long-running commands.

| Command | Overall deadline |
|---|---|
| Ordinary command | Ends when request and bounded retries complete |
| `config apply --wait` | Controlled by `--wait-timeout` |
| `monitor watch` | No overall deadline; each poll uses request timeout |
| Device login | Controlled by device-code expiration |

Default per-request timeout is 15 seconds.

## Group commands

Groups have stable lowercase-slug IDs and mutable display names. Monitor configuration refers to a group by ID, so renaming a group does not rewrite every monitor.

```text
pulsectl group list
pulsectl group list --all
pulsectl group create --id production --name "Production"
pulsectl group rename production --name "Customer-facing"
pulsectl group delete production --yes
```

`group list` supports `--limit`, `--cursor`, and `--all`. Create requires `--id` and `--name`. Rename requires the exact group ID and `--name`.

Group deletion is allowed only when the group is empty. The service returns `GROUP_NOT_EMPTY` when monitors still reference it. Interactive deletion prompts for confirmation; non-TTY deletion requires `--yes`.

Group reads require `monitors:read`. Group creation, rename, and deletion require `monitors:write`.

## Monitor commands

### List

```text
pulsectl monitor list
```

Flags:

```text
--state <state>
--group-id <groupId>
--group <legacy-group-name>
--enabled
--disabled
--limit <number>
--cursor <cursor>
--sort <field>
--all
--output <format>
```

`--group-id` is canonical. `--group` remains a legacy exact-name filter for version 1 scripts. They are mutually exclusive.

Default ordering:

```text
DOWN
VERIFYING_DOWN
VERIFYING_UP
PENDING
UP
PAUSED
ARCHIVED
```

Human CLI tables display uptime to four decimal places intentionally. Operational users need to distinguish values such as `99.9900%` and `99.9990%`. Machine output returns the exact API numeric value. Compact web lists may use fewer decimals.

### Get

```text
pulsectl monitor get api
pulsectl monitor get --id api
```

Exact monitor ID is canonical. Exact name lookup is optional and must return a conflict when ambiguous. No fuzzy command may select a monitor automatically.

### Create

```text
pulsectl monitor create \
  --id public-api \
  --name "Public API" \
  --url https://api.example.com \
  --group-id production \
  --method GET \
  --interval 1m \
  --timeout 8s \
  --expect 200-399 \
  --failure-threshold 2 \
  --recovery-threshold 2 \
  --recipient ops@example.com
```

Required flags:

```text
--id
--name
--url
```

Server defaults remain authoritative.

`--group-id <groupId>` assigns a stable configured group. `--group <legacy-group-name>` remains available for version 1 scripts and asks the service to resolve one exact case-insensitive name. The two flags are mutually exclusive. Omit both to create an ungrouped monitor.

### Update

```text
pulsectl monitor update public-api \
  --timeout 10s \
  --failure-threshold 3 \
  --group-id production
```

Only explicitly supplied fields change. Use explicit clear flags for nullable or list fields.

`--group-id` is canonical and `--group` is the retained legacy exact-name form. Use `--clear-group` to set `groupId` to null. `--group-id`, `--group`, and `--clear-group` are mutually exclusive.

### Pause and resume

```text
pulsectl monitor pause public-api
pulsectl monitor resume public-api
```

### Delete

```text
pulsectl monitor delete public-api
```

Interactive terminals prompt. Noninteractive execution requires `--yes`; otherwise exit 2.

### Test

```text
pulsectl monitor test public-api
```

Target failure returns exit 4. The test is non-persistent and does not affect incidents or uptime.

### Watch

```text
pulsectl monitor watch
pulsectl monitor watch --state down
pulsectl monitor watch --output jsonl
```

V1 watch uses polling, defaulting to 30 seconds.

`state_changed` events are derived locally by comparing consecutive snapshots. They are a convenience signal, not a complete transition log. A failure and recovery occurring between two polls may emit no event. Authoritative history comes from incident and state-history APIs.

Machine example:

```json
{"type":"snapshot","observedAt":"2026-07-18T03:15:00Z","monitors":[]}
{"type":"state_changed","observedAt":"2026-07-18T03:16:00Z","monitorId":"api","from":"UP","to":"VERIFYING_DOWN"}
```

## Declarative configuration

CRUD commands serve direct changes. Declarative configuration serves agents, repositories, and repeatable infrastructure workflows.

The current document version contains complete settings, groups, and monitors:

```yaml
version: 2

settings:
  concurrency: 25
  defaultTimeoutMs: 8000
  defaultFailureThreshold: 2
  defaultRecoveryThreshold: 2
  defaultRecipients:
    - ops@example.com
  userAgent: Pulse/1.0 (+https://pulse.example.com)

groups:
  - id: production
    name: Production

monitors:
  - id: website
    name: Website
    url: https://example.com
    enabled: true
    groupId: production
    method: GET
    intervalMinutes: 1
    timeoutMs: 8000
    expectedStatus:
      minimum: 200
      maximum: 399
    failureThreshold: 2
    recoveryThreshold: 2
    recipients: []
```

No silent settings merge is permitted.

Group IDs use the same lowercase-slug rule as monitor IDs, contain 3–64 characters, and remain stable across renames. Group names are trimmed, contain 1–50 characters, and are unique ignoring case. A document contains at most 100 groups. Every non-null monitor `groupId` must reference an entry in `groups`; use `null` for an ungrouped monitor.

The CLI continues to read version 1 documents. Before validation, plan, or apply, it upgrades each distinct trimmed legacy `monitor.group` name into a version 2 group with the deterministic ID `group-<first 12 hex characters of SHA-256(lowercased name)>`, replaces `group` with `groupId`, and sends version 2 to the service. Legacy names that differ only by case fold into one group and retain the first display spelling. Export always returns version 2. The first accepted mutation of a version 1 installation persists version 2.

### Export

```text
pulsectl config export
pulsectl config export --file monitors.yaml
```

Export returns the complete accepted configuration. Export followed by apply without changes must yield an empty plan.

Refuse to overwrite an existing file without `--force`.

### Validate

```text
pulsectl config validate --file monitors.yaml
pulsectl config validate --file -
cat monitors.yaml | pulsectl config validate --file -
```

Local validation covers parsing, schema, duplicate IDs, field ranges, and serialized size. The server repeats all validation authoritatively.

### Plan

```text
pulsectl config plan --file monitors.yaml
```

Plans are stateless. The response contains:

```text
baseConfigHash
targetConfigHash
planHash
settingsChanged
groupCreates
groupUpdates
groupDeletes
creates
updates
pauses
resumes
archives
unchanged
destructiveApprovalRequired
```

There is no plan `expiresAt`.

The CLI submits the current accepted base hash and complete version 2 target config. The server computes the authoritative diff. Group rename is an update under the same stable ID; removing an empty group is a group delete.

### Apply

```text
pulsectl config apply --file monitors.yaml
```

Safe interactive apply prompts once.

Destructive interactive apply requires the user to type the archive count.

Noninteractive destructive apply requires both:

```text
--allow-delete
--yes
```

Request:

```json
{
  "baseConfigHash": "sha256:...",
  "targetConfigHash": "sha256:...",
  "planHash": "sha256:...",
  "targetConfig": {},
  "allowDelete": true
}
```

The CLI sends the body `baseConfigHash` unchanged in `If-Match`. The server rejects disagreement, reloads current config, recomputes the target hash, diff, and plan hash under its advisory lock, then applies only when every value matches.

### Apply completion

Default behavior waits up to 15 seconds for the target hash to be accepted.

Flags:

```text
--wait
--no-wait
--wait-timeout <duration>
```

`--wait-timeout` controls the complete wait loop. Each poll uses the per-request `--timeout`.

A write that remains pending is still a successful write. Scripts requiring runtime acceptance must inspect the returned state or use `--wait`.

## Human terminal experience

| Behavior | Requirement |
|---|---|
| Color | Terminal only |
| `NO_COLOR` | Always respected |
| Width | Drop secondary columns before truncating primary data |
| Links | Terminal hyperlinks when supported |
| Spinners | stderr only |
| Prompts | TTY only |
| Errors | One-line summary plus one action |
| Secrets | Never shown after initial creation |

State remains textual; color never carries meaning alone.

## Agent experience

An agent should understand the complete CLI from:

```text
pulsectl --help
pulsectl help --output json
pulsectl config schema
```

Guarantees:

| Guarantee | Behavior |
|---|---|
| Command inventory | Root help lists every leaf command |
| Structured grammar | JSON help exposes flags, types, examples, and stdin support |
| Structured data | JSON returns one valid document |
| Streaming data | JSONL returns independent records |
| No prompts | Non-TTY mutation requires explicit flags |
| Stable IDs | Monitor ID is canonical |
| Stdin | Config accepts `--file -` |
| Idempotency | Retries reuse one key |
| Pagination | Machine list commands retrieve all pages unless limited |
| Determinism | Stable documented ordering |
| Time | RFC 3339 UTC |
| Errors | Stable API error and process exit codes |
| Secrets | Environment or stdin, never command arguments |

Agent environment:

```text
export PULSECTL_URL=https://pulse.example.com
export PULSECTL_TOKEN=pulse_live_...
export PULSECTL_OUTPUT=json
```

## HTTP client behavior

Use one shared `http.Client`.

```text
Per-request timeout: 15 seconds
Connection timeout: 5 seconds
TLS handshake timeout: 5 seconds
Response header timeout: 10 seconds
Idle connection timeout: 60 seconds
Maximum idle connections: 20
Maximum idle connections per host: 10
```

Retry policy:

| Request | Retry behavior |
|---|---|
| GET | Retry transient network failures, 429, 502, 503, and 504 |
| POST/PATCH/DELETE | Retry only with an idempotency key |
| 400–499 | No retry except 408 and 429 |
| Authentication failure | No retry |
| Conflict | No retry |
| Invalid input | No retry |

Use at most three attempts with bounded exponential backoff and jitter. Respect `Retry-After`. Manual monitor tests and token creation have stricter server-side limits; surface their remaining wait clearly and preserve exit code 8 when the retry budget cannot complete the command.

## Error rendering

Human:

```text
Error: configuration changed before the update was applied.

Current version: 14
Loaded version: 13

Run `pulsectl config plan --file monitors.yaml` again.
```

Machine:

```json
{
  "apiVersion": "v1",
  "kind": "Error",
  "error": {
    "code": "CONFIG_VERSION_CONFLICT",
    "message": "Configuration changed before the update was applied.",
    "details": {
      "currentVersion": 14,
      "loadedVersion": 13
    },
    "requestId": "req_..."
  }
}
```

Debug output may include request ID, method, sanitized URL, status, attempt count, elapsed time, and CLI version. It must redact authorization, tokens, cookies, and sensitive request fields.

## Doctor command

```text
pulsectl doctor
```

Checks:

- Config file parsing.
- Active context.
- Service URL.
- DNS and TLS.
- API reachability.
- Authentication.
- Token scopes.
- API compatibility.
- Local clock skew.
- Keyring availability.
- Terminal capabilities.

`doctor --output json` returns every check independently.

## Version compatibility

```text
pulsectl version
```

Server endpoint:

```text
GET /api/v1/version
```

The server reports supported API versions, minimum CLI version, and latest CLI version.

Do not implement automatic self-update in v1.

## Shell completion

```text
pulsectl completion bash
pulsectl completion zsh
pulsectl completion fish
pulsectl completion powershell
```

Dynamic completion may include contexts, monitor IDs, incident IDs, enum values, output formats, and token scopes. Network completion uses a short timeout and fails silently offline.

## Packaging and release

Release targets:

| Operating system | Architecture |
|---|---|
| macOS | arm64 |
| macOS | amd64 |
| Linux | arm64 |
| Linux | amd64 |
| Windows | arm64 |
| Windows | amd64 |

Artifacts include archives, checksums, signatures, SBOMs, and build metadata.

Install methods:

```text
Homebrew
Scoop
Direct GitHub release
go install for developers
```

Release pipeline:

```text
Run tests
Generate docs and machine manifest
Verify generated files have no diff
Build all targets with CGO_ENABLED=0
Run archive smoke tests
Generate checksums, signatures, and SBOM
Publish GitHub release
Update Homebrew and Scoop
```

## Security requirements

| Area | Requirement |
|---|---|
| TLS | HTTPS outside explicit localhost contexts |
| Tokens | Never log complete secrets |
| Human secrets | OS keyring |
| Agent secrets | Environment or stdin |
| Process listings | No token flag |
| Shell history | Token values never required as arguments |
| Retries | Reuse idempotency key |
| Deletion | Explicit confirmation |
| Debug logs | Redacted |
| File fallback | User-only permissions |
| Environment token | Never persisted |

## Telemetry and privacy

Collect no CLI usage telemetry in v1.

The service may observe token identity, request ID, CLI version, OS, architecture, and API route. Do not collect complete command arguments because they can contain URLs, email addresses, and filenames.

## Documentation generation

Generate Markdown references from Cobra. Every command requires a summary, usage, arguments, complete flags, machine behavior, exit codes, required scope, idempotency behavior, and at least one working example.

## Testing strategy

### Command discovery

- Root help contains every leaf command.
- Root help remains below the line budget.
- Detailed help golden files.
- JSON help conforms to schema.
- Generated docs and manifest match implementation.

### Output

- Redirected ordinary output defaults to JSON.
- Config export defaults to YAML in a pipe.
- Config schema defaults to JSON.
- Watch defaults to JSONL in a pipe.
- No ANSI in machine output.
- No stderr contamination of stdout.
- `NO_COLOR` removes ANSI.
- Four-decimal human uptime is intentional.

### Pagination

- Machine list auto-paginates without `--limit`.
- `--limit` caps total records.
- Cursor start works.
- Stable ordering across pages.
- Interrupted pagination emits no malformed JSON document.

### Authentication

- `pulsectl me` returns the current principal through `GET /api/v1/me` when already authenticated.
- Interactive unauthenticated `pulsectl me` creates a context from `--server`, launches linking, then prints identity.
- Noninteractive unauthenticated `pulsectl me` never opens a browser and exits 7.
- `PULSECTL_TOKEN` makes `me` a read-only passthrough without keyring writes.
- Installation ID generation, persistence, naming, and request metadata.
- Full-scope approval contains every documented administrator scope and no scope picker.
- Authorization links the correct installation and account under concurrent polling.
- Installation revocation invalidates every associated CLI session.
- Device pending, slow-down, denial, and expiry.
- Poll interval increase.
- Keyring save and removal.
- Environment token precedence.
- Revoked and expired session behavior.
- Expiry requires re-login.
- Scope denial maps to exit 7.
- Agent-token expiry defaults to 90 days and rejects values above 365 days.
- Created scopes cannot exceed creator scopes.
- Child token expiry cannot exceed creator expiry.

### HTTP and idempotency

- Request ID on every request.
- Same idempotency key across retries.
- Safe mutation retry.
- Rate limit respects `Retry-After`.
- `If-Match` and body base hash are identical.
- Precondition mismatch is treated as client construction failure.
- Manual-test and token-creation rate limits respect `Retry-After` and map to exit 8 when unresolved.
- Conflict maps to exit 6.
- Service failure maps to exit 9.

### Configuration

- Export includes settings, groups, and monitors in version 2.
- Version 2 export/apply round-trip.
- Version 1 input upgrades deterministically to version 2.
- Group IDs and case-insensitive names are unique; monitor group references resolve.
- Group creates, renames, and deletes have deterministic plan ordering.
- YAML, JSON, and stdin input.
- Deterministic plan ordering.
- No `expiresAt` in plan.
- Base-hash conflict.
- Destructive apply requires both flags in non-TTY mode.
- Apply wait uses `--wait-timeout`.
- Per-request timeout applies independently to polls.

### Watch and signals

- Watch has no overall timeout.
- Each poll uses request timeout.
- Client-derived transitions are documented and tested.
- SIGINT exits 130.
- SIGINT during JSON output never emits malformed JSON.
- Terminal state restores after interruption.

### Agent contract

A black-box suite receives only:

```text
pulsectl --help
pulsectl help --output json
pulsectl config schema
```

It must construct and run commands for listing, reading, creating, updating, pausing, resuming, testing, planning, applying, incident reading, token use, and status inspection.

### Cross-platform

Run CI on macOS, Linux, and Windows. Smoke-test every release archive, including Windows ARM64. Verify `CGO_ENABLED=0` and keyring compilation for every target.

## Implementation phases

| Phase | Deliverable | Completion gate |
|---|---|---|
| API contract | OpenAPI v1 imported from service | Generated models compile |
| CLI foundation | Cobra, contexts, output, signals | Root and JSON help pass |
| Authentication | `me`, installation linking, device flow, tokens, keyring | Human and agent login pass; installation identity is stable |
| Read operations | Monitors, incidents, status, doctor | Table and machine output pass |
| Pagination | Cursor client and automatic machine pagination | Large-list tests pass |
| Mutations | CRUD, pause, resume, delete, test | Idempotency and confirmation tests pass |
| Declarative config | Complete export, validate, stateless plan, apply | Round-trip and conflict tests pass |
| Human polish | Tables, color, completion, concise errors | Golden tests pass |
| Agent contract | JSON help, schemas, stdin, stable exit codes | Black-box suite passes |
| Packaging | GoReleaser, Homebrew, Scoop | Fresh target installs work |
| Hardening | Retry, interruption, compatibility, security | Release suite passes |

## Acceptance criteria

| ID | Requirement |
|---|---|
| CLI-01 | One binary builds for macOS, Linux, and Windows |
| CLI-02 | No-argument help shows every leaf command |
| CLI-03 | JSON help exposes the complete grammar |
| CLI-04 | Ordinary redirected output defaults to JSON |
| CLI-05 | Config export defaults to YAML in terminals and pipes |
| CLI-06 | Machine list commands auto-paginate without a limit |
| CLI-07 | stdout contains data only |
| CLI-08 | stderr contains diagnostics only |
| CLI-09 | Machine timestamps use RFC 3339 UTC |
| CLI-10 | Exit codes follow the documented contract |
| CLI-11 | SIGINT exits 130 and restores terminal state |
| CLI-12 | Human login handles all device-flow states |
| CLI-13 | Session expiration requires re-login |
| CLI-14 | Agent authentication works through `PULSECTL_TOKEN` |
| CLI-15 | Secrets never appear in debug logs |
| CLI-16 | Human credentials use `zalando/go-keyring` |
| CLI-17 | Every mutation carries one idempotency key across retries |
| CLI-18 | Monitor CRUD works through `/api/v1` |
| CLI-19 | Manual target failure returns exit 4 |
| CLI-20 | Export includes complete version 2 settings, groups, and monitors; version 1 input upgrades deterministically |
| CLI-21 | Export/apply round-trips without semantic change |
| CLI-22 | Plans are stateless and contain no expiry |
| CLI-23 | Apply sends matching body and `If-Match` base hashes |
| CLI-24 | Destructive apply requires explicit delete permission |
| CLI-25 | Noninteractive commands never prompt |
| CLI-26 | `--file -` accepts stdin |
| CLI-27 | `--timeout` applies per request |
| CLI-28 | `--wait-timeout` governs apply acceptance waiting |
| CLI-29 | Watch has no overall timeout |
| CLI-30 | Watch transition events are documented as client-derived |
| CLI-31 | Human uptime tables display four decimals intentionally |
| CLI-32 | `NO_COLOR` removes all ANSI sequences |
| CLI-33 | Shell completion works for four shells |
| CLI-34 | Doctor diagnoses config, network, auth, scopes, and compatibility |
| CLI-35 | Created token scopes never exceed creator scopes |
| CLI-36 | Agent tokens require expiry and cap it at 365 days |
| CLI-37 | Rate-limited test and token commands honor `Retry-After` |
| CLI-38 | Agent black-box suite completes all core workflows |
| CLI-39 | Release archives include checksums, signatures, and build metadata |
| CLI-40 | `pulsectl me` returns the current principal and installation through `/api/v1/me` |
| CLI-41 | Interactive unauthenticated `pulsectl me` automatically starts browser installation linking |
| CLI-42 | Human installation approval grants exactly the complete documented administrator scope set |
| CLI-43 | Noninteractive `me` never launches a browser or prompts |
| CLI-44 | Revoking a linked installation revokes every session issued to it |

## Definition of done

The CLI is complete when a human can install one native binary, authenticate through browser device authorization, manage monitors with clear terminal output, and safely apply complete configuration documents; an agent can discover the full grammar from default and JSON help, authenticate through a scoped environment token, consume stable machine output, auto-paginate lists, provide config through stdin, and execute every workflow without prompts; and all behavior passes through the service’s versioned API, persistent idempotency, scope enforcement, and serialized configuration engine.
