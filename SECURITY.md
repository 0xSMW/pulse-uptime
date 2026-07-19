# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through the repository’s **Security → Report a vulnerability** flow on GitHub. Include the affected route or command, reproduction steps, impact, and any suggested mitigation.

Do not disclose a vulnerability publicly until a fix is available. Expect an acknowledgement within three business days and a status update within seven business days.

## Supported version

Security fixes target the current production release and the default branch.

## Security boundaries

Pulse treats monitor destinations, API inputs, CLI responses, redirects, DNS answers, and provider responses as untrusted. Reports involving SSRF, authentication bypass, token disclosure, cross-principal access, duplicate notification delivery, configuration safety, or scheduler concurrency are especially valuable.

Status report and announcement markdown is rendered escape-first by a restricted renderer that permits links, bold, italic, and inline code only. Content that executes script on the public status page through these fields is in scope.

## Accepted risks and disclosures

The status page settings accept raw `customCss` and `customHead` values. These fields are an accepted self-XSS surface: Pulse is a single-administrator, self-hosted deployment, the content is injected only into the operator’s own status page, and writes require the `config:write` scope. Script execution through these fields alone is not a vulnerability.

Signing in to the dashboard records each session’s user agent and client IP address so active sessions can be reviewed and revoked under **Settings → Security**. These values are captured once at login and stored alongside the session.

