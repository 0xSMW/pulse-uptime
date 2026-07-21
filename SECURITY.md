# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through the repository’s **Security → Report a vulnerability** flow on GitHub. Include the affected route or command, reproduction steps, impact, and any suggested mitigation.

Do not disclose a vulnerability publicly until a fix is available. Expect an acknowledgement within three business days and a status update within seven business days.

## Supported version

Security fixes target the current production release and the default branch.

## Security boundaries

Pulse treats monitor destinations, API inputs, CLI responses, redirects, DNS answers, and provider responses as untrusted. Reports involving SSRF, authentication bypass, token disclosure, cross-principal access, duplicate notification delivery, configuration safety, or scheduler concurrency are especially valuable.

Status report and announcement markdown is rendered escape-first by a restricted renderer that permits links, bold, italic, and inline code only. Content that executes script on the public status page through these fields is in scope.

`customHead` accepts only allowlisted `meta` and icon-related `link` elements. The value is parsed on write and again on render as inert React nodes, never injected as raw HTML. Script tags, event handlers, stylesheet links, redirects, and other executable fragments are rejected. Bypass of that allowlist on the public status page is in scope.

## Accepted risks and disclosures

The status page settings accept raw `customCss` (at most 10 KB) injected as a `<style>` element on the operator’s own public status page. This is an accepted self-XSS surface: Pulse is a single-administrator, self-hosted deployment, writes require the `config:write` scope, and the stylesheet cannot load third-party scripts by itself. CSS-only self-XSS through `customCss` alone is not a vulnerability.

Signing in to the dashboard records each session’s user agent and client IP address so active sessions can be reviewed and revoked under **Settings → Security**. These values are captured once at login and stored alongside the session.
