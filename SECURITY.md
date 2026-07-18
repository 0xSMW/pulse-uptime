# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through the repository’s **Security → Report a vulnerability** flow on GitHub. Include the affected route or command, reproduction steps, impact, and any suggested mitigation.

Do not disclose a vulnerability publicly until a fix is available. Expect an acknowledgement within three business days and a status update within seven business days.

## Supported version

Security fixes target the current production release and the default branch.

## Security boundaries

Pulse treats monitor destinations, API inputs, CLI responses, redirects, DNS answers, and provider responses as untrusted. Reports involving SSRF, authentication bypass, token disclosure, cross-principal access, duplicate notification delivery, configuration safety, or scheduler concurrency are especially valuable.

