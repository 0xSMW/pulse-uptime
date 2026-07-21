The review is complete. Here is the full report.

## TLDR

Three rounds of 8 finder angles produced **93 verified candidates**: **40 CONFIRMED** (3 high severity), **38 PLAUSIBLE** (appendix), **15 REFUTED and dropped**. The three high-severity findings: `pulsectl auth logout` says "Remove a linked session" but revokes the whole installation plus every API token its sessions ever minted; onboarding's `activateFirstMonitor` performs the non-rollbackable Edge Config write *inside* its Postgres transaction with four statements after it (violating the runs-last discipline `config-mutation.ts` documents); and `loadAcceptedConfiguration` consumes destructive-change approvals and writes two tables under a read name. A recurring theme the review surfaced: read-named functions that write (`findSessionByDigest`, `listDueSources`, `getPendingDeviceAuthorization`, `checkOnboardingReadiness`), and CLI-fabricated envelopes diverging from what the server actually sends (`MonitorArchived` vs `MonitorArchival`, `Logout` vs `CliSessionRevocation`).

```json
{
  "findings": [
    {
      "file": "cli/internal/command/adminops/adminops.go",
      "line": 132,
      "category": "domain_language",
      "severity": "high",
      "summary": "pulsectl auth logout's help text promises removing one linked session but the operation revokes the entire CLI installation, every session under it, and every API token any of those sessions created.",
      "current": "Use: \"logout\", Short: \"Remove a linked session\" -> POST /api/v1/cli-auth/revoke -> revokeCliInstallation with token cascade",
      "proposed": "Short: \"Revoke this installation and any tokens it created\" plus a prompt that names the token cascade. Also document the cascade in Docs/Specs/CLI-INIT.md, which currently omits it.",
      "reason": "Silent blast radius on a destructive, security-sensitive operation: automation using a token minted through this CLI breaks on logout with no warning. The spec confirms installation-wide session revocation is intended but nothing documents the API-token cascade.",
      "scope": "public_api",
      "affected_symbols": ["adminops.logout", "revokeCliInstallation"],
      "evidence": {
        "declaration": "logout := &cobra.Command{Use: \"logout\", Short: \"Remove a linked session\", ...}",
        "call_site": "revoked: await revokeCliInstallation(context.principal, new Date(), tx)",
        "behavior": "// Cascade to any API tokens minted by this installation's CLI sessions ... await tx.update(apiTokens).set({ revokedAt: now })"
      },
      "example": {
        "before": "pulsectl auth logout   # \"Remove a linked session\"",
        "after": "pulsectl auth logout   # \"Revoke this installation and any tokens it created\""
      },
      "migration_risk": "Help-text and docs change only, no behavior change. Optionally narrow the backend action later, which would be a behavior change requiring its own decision.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/scheduler/runtime.ts",
      "line": 103,
      "category": "function_naming",
      "severity": "high",
      "summary": "loadAcceptedConfiguration promises a read but consumes a destructive-change approval, writes monitoring_config_snapshots and config_operations in a transaction, synchronizes the monitor registry, and logs.",
      "current": "async function loadAcceptedConfiguration(now: Date): Promise<MonitoringConfig>",
      "proposed": "Extract findPendingDestructiveApproval(candidateHash, now) and acceptConfiguration(desired, previous, approvalId, now); keep loadAcceptedConfiguration as the orchestrator whose name then matches a read-evaluate-delegate role.",
      "reason": "Every other load* function in the codebase is a pure read. This one authorizes and persists a destructive change; callers cannot see that a call consumes an approval.",
      "scope": "local",
      "affected_symbols": ["loadAcceptedConfiguration"],
      "evidence": {
        "declaration": "async function loadAcceptedConfiguration(now: Date): Promise<MonitoringConfig> {",
        "call_site": "activeConfig = await loadAcceptedConfiguration(now)",
        "behavior": "marks config_change_approvals.consumedAt, inserts monitoringConfigSnapshots, updates configOperations in db.transaction, then await synchronizeRegistry(result.config, result.hash, now)"
      },
      "example": {
        "before": "activeConfig = await loadAcceptedConfiguration(now)",
        "after": "activeConfig = await loadAcceptedConfiguration(now) // internally: findPendingDestructiveApproval(...) then acceptConfiguration(...)"
      },
      "migration_risk": "Private function with one call site, mechanical extraction.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/onboarding/service.ts",
      "line": 214,
      "category": "responsibility",
      "severity": "high",
      "summary": "activateFirstMonitor calls the non-rollbackable Edge Config write inside db.transaction with four Postgres statements after it, so a late failure leaves Edge Config live while Postgres rolls back.",
      "current": "db.transaction(async (tx) => { ...; await writeEdgeConfig(config); insert snapshots; upsert registry; insert monitorState; update onboardingProgress })",
      "proposed": "Compute and validate inside the transaction, commit, then writeEdgeConfig after commit, matching lib/api/config-mutation.ts's documented runs-last discipline.",
      "reason": "config-mutation.ts places writeEdgeConfig last with a comment explaining it cannot be rolled back. This second call path reverses the order with no justification: a constraint violation after the write leaves onboarding stuck with orphaned edge-side monitoring.",
      "scope": "cross_file",
      "affected_symbols": ["activateFirstMonitor", "writeEdgeConfig"],
      "evidence": {
        "declaration": "export async function activateFirstMonitor(userId: string, input: { alertEmail?: string; startAnyway?: boolean })",
        "call_site": "// config-mutation.ts:126: writeEdgeConfig is an external HTTP call and cannot be rolled back, so it runs last",
        "behavior": "await writeEdgeConfig(config) at line 214, followed by tx.insert(monitoringConfigSnapshots), upsert monitorRegistry, insert monitorState, update onboardingProgress inside the same transaction"
      },
      "example": {
        "before": "return db.transaction(async (tx) => { ...; await writeEdgeConfig(config); ...tx.insert(...)... })",
        "after": "const committed = await db.transaction(async (tx) => { ...; return { config, monitor } }); await writeEdgeConfig(committed.config)"
      },
      "migration_risk": "Reordering within one function; the existing ACTIVATION_FAILED error path must cover a post-commit write failure.",
      "verification": "CONFIRMED"
    },
    {
      "file": "cli/internal/command/monitorops/monitorops.go",
      "line": 439,
      "category": "domain_language",
      "severity": "medium",
      "summary": "pulsectl monitor delete's help text says Delete while its own prompt, the API, OpenAPI, and DB all say archive; sibling report delete is a genuine irreversible hard delete, so one verb means two data operations.",
      "current": "Use: \"delete <id>\", Short: \"Delete a monitor\", flag help \"Confirm deletion\", but prompt \"Archive monitor %s? [y/N]\" and archivedAt-only soft delete",
      "proposed": "Rename to archive <id> / \"Archive a monitor\" / \"Confirm archival\", keeping delete as a hidden Cobra alias for compatibility.",
      "reason": "A user who has seen report delete (\"This cannot be undone\") reasonably expects monitor delete to destroy data; it archives reversibly. The command contradicts itself between Short and prompt.",
      "scope": "public_api",
      "affected_symbols": ["monitorops delete command"],
      "evidence": {
        "declaration": "cmd := &cobra.Command{Use: \"delete <id>\", Short: \"Delete a monitor\", ...}",
        "call_site": "objectEnvelope(\"MonitorArchival\", await archiveMonitor(monitorId, ...), ...)",
        "behavior": "fmt.Fprintf(d.Err, \"Archive monitor %s? [y/N] \", id)"
      },
      "example": {
        "before": "pulsectl monitor delete mon_123",
        "after": "pulsectl monitor archive mon_123   (delete kept as hidden alias)"
      },
      "migration_risk": "Cobra aliases preserve backward compatibility; manifest and docs/cli page regenerate.",
      "verification": "CONFIRMED"
    },
    {
      "file": "cli/internal/command/adminops/adminops.go",
      "line": 166,
      "category": "convention",
      "severity": "medium",
      "summary": "auth logout discards the server's CliSessionRevocation envelope (whose revoked field can be false) and unconditionally renders a fabricated kind Logout / loggedOut: true.",
      "current": "POST /cli-auth/revoke into var ignored, then render {\"kind\": \"Logout\", \"data\": {\"loggedOut\": true}}",
      "proposed": "Parse and surface the server's CliSessionRevocation envelope, or at minimum align kind/field to CliSessionRevocation/revoked as sibling tokenRevoke already does for its field name.",
      "reason": "The CLI's displayed result is disconnected from what the server reported, so a revocation outcome change can never surface. Third vocabulary for one action.",
      "scope": "public_api",
      "affected_symbols": ["adminops.logout render"],
      "evidence": {
        "declaration": "return render(d, map[string]any{\"apiVersion\": \"v1\", \"kind\": \"Logout\", \"data\": map[string]any{\"loggedOut\": true}}, \"table\")",
        "call_site": "d.Client.Do(cmd.Context(), http.MethodPost, \"/api/v1/cli-auth/revoke\", map[string]any{}, nil, &ignored)",
        "behavior": "server: objectEnvelope(\"CliSessionRevocation\", { revoked: <bool> }, requestId)"
      },
      "example": {
        "before": "pulsectl auth logout -> {\"kind\": \"Logout\", \"data\": {\"loggedOut\": true}}",
        "after": "pulsectl auth logout -> {\"kind\": \"CliSessionRevocation\", \"data\": {\"revoked\": true}}"
      },
      "migration_risk": "Scripts parsing the fabricated shape would need the new kind; no test pins the current one.",
      "verification": "CONFIRMED"
    },
    {
      "file": "cli/internal/command/monitorops/monitorops.go",
      "line": 466,
      "category": "convention",
      "severity": "medium",
      "summary": "The CLI discards the DELETE response and fabricates kind MonitorArchived with {id}, while the server sends MonitorArchival with {id, archived: true}, so the same operation reports different kinds per client.",
      "current": "doc := Envelope{APIVersion: \"v1\", Kind: \"MonitorArchived\", Data: {\"id\": ...}} after a Do call with no Result target",
      "proposed": "Pass Result: &doc on the DELETE (sibling pause/resume/test already do) and render the server's own envelope.",
      "reason": "kind is the wire discriminant; grep proves each spelling is unique to its side. The client fabrication also drops the archived: true field.",
      "scope": "public_api",
      "affected_symbols": ["monitorops delete RunE"],
      "evidence": {
        "declaration": "doc := Envelope{APIVersion: \"v1\", Kind: \"MonitorArchived\", Data: json.RawMessage(fmt.Sprintf(`{\"id\":%q}`, id))}",
        "call_site": "d.Client.Do(cmd.Context(), Request{Method: http.MethodDelete, Path: monitorPath(id), IdempotencyKey: key})",
        "behavior": "server route: objectEnvelope(\"MonitorArchival\", { id, archived: true }, ...)"
      },
      "example": {
        "before": "Do(..., Request{Method: DELETE, Path: monitorPath(id), IdempotencyKey: key}); doc := fabricated envelope",
        "after": "Do(..., Request{Method: DELETE, Path: monitorPath(id), IdempotencyKey: key, Result: &doc})"
      },
      "migration_risk": "Mechanical, matches the established local idiom; no test pins the fabricated kind.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/auth/service.ts",
      "line": 421,
      "category": "function_naming",
      "severity": "medium",
      "summary": "findSessionByDigest silently schedules a lastSeenAt UPDATE, while its sibling principal lookups (findApiToken/findCliSession) are pure and pair with explicit touch* calls at the call site.",
      "current": "findSessionByDigest(digest, now) with an internal after()-deferred humanSessions update",
      "proposed": "Keep findSessionByDigest pure and add an explicit touchSessionActivity call in getCurrentSession, mirroring the resolvePrincipal/touchApiToken/touchCliSession pattern in lib/api/principal.ts.",
      "reason": "Proven in-repo convention conflict between sibling principal-resolution functions; a find name with a hidden write breaks read-only assumptions for cache()-wrapped callers.",
      "scope": "cross_file",
      "affected_symbols": ["findSessionByDigest", "getCurrentSession"],
      "evidence": {
        "declaration": "export async function findSessionByDigest(digest: Buffer, now = new Date()): Promise<HumanSession | null> {",
        "call_site": "return token ? findSessionByDigest(digestSessionToken(token)) : null",
        "behavior": "if (shouldRefreshLastSeen(lastSeenAt, now)) { ... db.update(humanSessions).set({ lastSeenAt: now }) }"
      },
      "example": {
        "before": "return token ? findSessionByDigest(digestSessionToken(token)) : null",
        "after": "const session = await findSessionByDigest(digest); if (session) touchSessionActivity(session.sessionId, now)"
      },
      "migration_risk": "Requires exposing lastSeenAt from the find for the caller's staleness check, same as principal.ts already does.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/dependencies/poller.ts",
      "line": 45,
      "category": "function_naming",
      "severity": "medium",
      "summary": "PollerStore.listDueSources is documented as a plain read but its sole implementation runs CLAIM_DUE_SOURCES_SQL, an UPDATE...RETURNING that advances next_poll_at as a claim.",
      "current": "listDueSources: (now: Date) => Promise<PollerSourceRow[]> with a read-only doc comment",
      "proposed": "Rename to claimDueSources, matching the honestly named CLAIM_DUE_SOURCES_SQL, and state the claim behavior in the interface doc.",
      "reason": "A test double or second implementation written to the current contract would use a read-only SELECT and silently reintroduce the double-poll race the claim exists to prevent.",
      "scope": "cross_file",
      "affected_symbols": ["PollerStore.listDueSources", "createDueSourceStore"],
      "evidence": {
        "declaration": "/** Enabled sources with at least one installed dependency and next_poll_at <= now. */ listDueSources: (now: Date) => Promise<PollerSourceRow[]>",
        "call_site": "const sources = await deps.store.listDueSources(nowDate)",
        "behavior": "update dependency_sources as ds set next_poll_at = $2 from due where ds.id = due.id returning ..."
      },
      "example": {
        "before": "const sources = await deps.store.listDueSources(nowDate)",
        "after": "const sources = await deps.store.claimDueSources(nowDate)"
      },
      "migration_risk": "One interface, one implementation, one call site, test mocks.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/api/device-authorization.ts",
      "line": 68,
      "category": "function_naming",
      "severity": "medium",
      "summary": "getPendingDeviceAuthorization runs an expiry UPDATE before its SELECT even though the SELECT independently filters expired rows, hiding unrelated housekeeping inside a getter.",
      "current": "getPendingDeviceAuthorization(userCode, now) opens with db.update(deviceAuthorizations).set({ state: \"expired\" })",
      "proposed": "Extract expireStaleDeviceAuthorizations(now) and call it from the one caller; keep the getter pure.",
      "reason": "The repo's own idempotency module keeps expiry mutations in named functions (reclaimExpiredRecord, claimStale). The SELECT already filters on state and expiresAt, so the write is bookkeeping, not correctness.",
      "scope": "cross_file",
      "affected_symbols": ["getPendingDeviceAuthorization"],
      "evidence": {
        "declaration": "export async function getPendingDeviceAuthorization(userCode: string, now = new Date()): Promise<PendingDeviceAuthorization | null> {",
        "call_site": "const request = presentRequest(await getPendingDeviceAuthorization(parsed.code))",
        "behavior": "await db.update(deviceAuthorizations).set({ state: \"expired\" }).where(... lte(deviceAuthorizations.expiresAt, now))"
      },
      "example": {
        "before": "const request = presentRequest(await getPendingDeviceAuthorization(parsed.code))",
        "after": "await expireStaleDeviceAuthorizations(now); const request = presentRequest(await getPendingDeviceAuthorization(parsed.code))"
      },
      "migration_risk": "One caller; a forgotten sweep only leaves rows cosmetically stale.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/onboarding/readiness.ts",
      "line": 18,
      "category": "function_naming",
      "severity": "medium",
      "summary": "checkOnboardingReadiness reads as a diagnostic but its Edge Config probe unconditionally PATCHes a sentinel key to api.vercel.com on every call; the calling route needs a comment plus an auth gate to compensate.",
      "current": "checkOnboardingReadiness()",
      "proposed": "Rename to verifyOnboardingReadiness (documented as performing provider writes), or split the pure status read from the write-performing probes.",
      "reason": "The route comment ('The readiness probe performs privileged provider writes') is the name doing the wrong job. Note the email probe only sends a test email conditionally; the Edge Config write is the unconditional one.",
      "scope": "cross_file",
      "affected_symbols": ["checkOnboardingReadiness", "createEdgeConfigProbe"],
      "evidence": {
        "declaration": "export async function checkOnboardingReadiness() {",
        "call_site": "// The readiness probe performs privileged provider writes (Edge Config, email)...",
        "behavior": "method: \"PATCH\", body: JSON.stringify({ items: [{ operation: \"upsert\", ... }] })  // api.vercel.com"
      },
      "example": {
        "before": "const report = await checkOnboardingReadiness()",
        "after": "const report = await verifyOnboardingReadiness() // performs Edge Config write"
      },
      "migration_risk": "Three call sites, internal only.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/api/config-mutation.ts",
      "line": 85,
      "category": "function_naming",
      "severity": "medium",
      "summary": "mutateConfig, the sole mutation path for all monitor/group writes, hides a non-rollbackable outbound PATCH to Vercel Edge Config behind a name that reads as an in-process change.",
      "current": "mutateConfig(principalKey, mutator, handle)",
      "proposed": "applyConfigChange(principalKey, mutator, handle), with the doc noting the trailing external write.",
      "reason": "Callers must read the implementation to learn network I/O with no rollback occurs; every monitor/group create/update/archive flows through it.",
      "scope": "cross_file",
      "affected_symbols": ["mutateConfig"],
      "evidence": {
        "declaration": "export async function mutateConfig(principalKey: string, mutator: (config: MonitoringConfig) => MonitoringConfig, handle: DatabaseHandle = db): Promise<MonitoringConfig> {",
        "call_site": "const result = await mutateConfig(principalKey, (current) => { ... })",
        "behavior": "// writeEdgeConfig is an external HTTP call and cannot be rolled back, so it runs last ... await writeEdgeConfig(target)"
      },
      "example": {
        "before": "await mutateConfig(principalKey, (current) => nextConfig(current, ...))",
        "after": "await applyConfigChange(principalKey, (current) => nextConfig(current, ...))"
      },
      "migration_risk": "Internal rename across lib/api/monitors.ts and groups.ts call sites.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/dependencies/persist.ts",
      "line": 648,
      "category": "function_naming",
      "severity": "medium",
      "summary": "persistSnapshot runs for every poll outcome kind (two of its three paths have no snapshot at all), derives dependency state, upserts and closes provider incidents, and enqueues notifications; the storage verb hides all of it.",
      "current": "persistSnapshot(store, outcome, source, context) with three comment-delimited branches in a ~400-line body",
      "proposed": "Rename to applyPollOutcome and extract applyNotModifiedOutcome / applyFailureOutcome / applySnapshotOutcome as named locals inside the same transaction.",
      "reason": "A reader hunting for where dependency alert emails trigger would never open a function named persist; the third branch is delimited only by a comment.",
      "scope": "cross_file",
      "affected_symbols": ["persistSnapshot"],
      "evidence": {
        "declaration": "export async function persistSnapshot(store: PersistStore, outcome: PollOutcome, source: PersistSourceRow, context: PersistContext): Promise<PersistSummary> {",
        "call_site": "await persistSnapshot(persistStore, outcome, source, { now, defaultRecipients })",
        "behavior": "// outcome.kind === \"snapshot\"  ... const enqueued = await tx.enqueueNotification({ event, sourceId, dependencyId, ... }, context.now)"
      },
      "example": {
        "before": "await persistSnapshot(persistStore, outcome, source, { now, defaultRecipients })",
        "after": "await applyPollOutcome(persistStore, outcome, source, { now, defaultRecipients })"
      },
      "migration_risk": "One production call site plus two test files; extraction stays inside the store.transaction closure, preserving atomicity.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/api/monitors.ts",
      "line": 509,
      "category": "domain_language",
      "severity": "medium",
      "summary": "The single on-demand check operation is called test by the API/CLI, check in DB and UI messages, and probe in a comment, proven identical via the shared createHttpChecker (mode manual vs scheduled).",
      "current": "testMonitor(), /monitors/{id}/test, MonitorTest kind, UI 'Test Monitor' button whose loading state says 'Checking…' and failure says 'Monitor check failed', comment says probe",
      "proposed": "Standardize on check everywhere the name is not already public contract (keep the route, operationId, CLI verb); align UI-internal wording and fix the stray probe comment.",
      "reason": "Grep for check misses the API layer entirely; three synonyms for one code path.",
      "scope": "cross_file",
      "affected_symbols": ["testMonitor", "runTest", "monitor-actions comment"],
      "evidence": {
        "declaration": "export async function testMonitor(id: string) {",
        "call_site": "objectEnvelope(\"MonitorTest\", await testMonitor(id), context.requestId)",
        "behavior": "// A completed probe can still fail. ... a failed check reads as a failure, not success."
      },
      "example": {
        "before": "// A completed probe can still fail.",
        "after": "// A completed check can still fail."
      },
      "migration_risk": "Public contract untouched; UI copy and comments only.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/checker/types.ts",
      "line": 29,
      "category": "value_naming",
      "severity": "medium",
      "summary": "A second exported MonitorConfig type with zero importers shadows the canonical MonitorConfig from lib/config/schema.ts with a stale shape (legacy group instead of groupId).",
      "current": "export type MonitorConfig = CheckTarget & { ...; group: string | null; ... } in lib/checker/types.ts",
      "proposed": "Delete the unused export (or rename to CheckerMonitorInput if a checker-local shape is ever needed).",
      "reason": "Auto-import and go-to-definition become ambiguous between a dead, diverged type and the live one.",
      "scope": "cross_file",
      "affected_symbols": ["MonitorConfig (lib/checker/types.ts)"],
      "evidence": {
        "declaration": "export type MonitorConfig = CheckTarget & { id: string; name: string; enabled: boolean; group: string | null; ... }",
        "call_site": "export type MonitorConfig = z.infer<typeof monitorConfigSchema>  // the live one, uses groupId",
        "behavior": "repo-wide grep: only CheckErrorCode is imported from checker/types elsewhere; this MonitorConfig has no importers"
      },
      "example": {
        "before": "import type { MonitorConfig } from \"@/lib/checker/types\"",
        "after": "import type { MonitorConfig } from \"@/lib/config/schema\""
      },
      "migration_risk": "None, zero importers.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/scheduler/registry-sync.ts",
      "line": 36,
      "category": "value_naming",
      "severity": "medium",
      "summary": "Three functions are all named synchronizeRegistry (the shared implementation plus two mode-pinned wrappers), forcing both wrapper files to import the real one under an alias to avoid shadowing themselves.",
      "current": "synchronizeRegistry in registry-sync.ts, runtime.ts, and config-mutation.ts; both callers write `import { synchronizeRegistry as syncRegistryRows }`",
      "proposed": "Rename the wrappers synchronizeRegistryForRuntime and synchronizeRegistryForApi, reusing the existing RegistrySyncMode vocabulary; import the shared implementation unaliased.",
      "reason": "Go-to-definition and grep surface three unrelated declarations; the aliasing is itself evidence of the cost.",
      "scope": "cross_file",
      "affected_symbols": ["synchronizeRegistry (x3)"],
      "evidence": {
        "declaration": "export async function synchronizeRegistry(tx: DbTransaction, config: MonitoringConfig, hash: string, now: Date, mode: RegistrySyncMode)",
        "call_site": "import { synchronizeRegistry as syncRegistryRows } from \"./registry-sync\"",
        "behavior": "export async function synchronizeRegistry(tx, config, hash, now): Promise<void> { await syncRegistryRows(tx, config, hash, now, \"api\") }"
      },
      "example": {
        "before": "import { synchronizeRegistry as syncRegistryRows } from \"./registry-sync\"\nasync function synchronizeRegistry(config, hash, now) { ... }",
        "after": "import { synchronizeRegistry } from \"./registry-sync\"\nasync function synchronizeRegistryForRuntime(config, hash, now) { ... }"
      },
      "migration_risk": "Module-private wrappers, one call site each.",
      "verification": "CONFIRMED"
    },
    {
      "file": "components/settings/settings-api.ts",
      "line": 27,
      "category": "call_site",
      "severity": "medium",
      "summary": "apiRequest's trailing boolean forces 14 production call sites to end in a bare true whose meaning (attach an Idempotency-Key header) is invisible.",
      "current": "apiRequest<T>(url, init = {}, mutation = false)",
      "proposed": "apiRequest<T>(url, init = {}, { attachIdempotencyKey } = {}) or a mutateRequest(url, init) wrapper that always sets it.",
      "reason": "The reader cannot tell what true means without opening the implementation; 14 call sites repeat the pattern.",
      "scope": "cross_file",
      "affected_symbols": ["apiRequest"],
      "evidence": {
        "declaration": "export async function apiRequest<T>(url: string, init: RequestInit = {}, mutation = false): Promise<T> {",
        "call_site": "await apiRequest(`/api/v1/monitors/${encodeURIComponent(monitor.id)}/${action}`, { method: \"POST\" }, true)",
        "behavior": "if (mutation) { headers.set(\"Idempotency-Key\", crypto.randomUUID()) }"
      },
      "example": {
        "before": "await apiRequest(url, { method: \"POST\" }, true)",
        "after": "await apiRequest(url, { method: \"POST\" }, { attachIdempotencyKey: true })"
      },
      "migration_risk": "14 call sites plus 2 tests, mechanical.",
      "verification": "CONFIRMED"
    },
    {
      "file": "app/api/v1/dependencies/[dependencyId]/route.ts",
      "line": 19,
      "category": "convention",
      "severity": "medium",
      "summary": "The dependencies DELETE hand-rolls a 204 with 2 of the 5 headers apiJson sets, making it the only v1 route whose responses omit the CLI version-negotiation headers.",
      "current": "local noContent() sets Cache-Control and X-Pulse-API-Version only; all 6 sibling DELETE routes return via apiJson",
      "proposed": "Add an apiNoContent() helper to lib/api/envelopes.ts sharing apiJson's header code, or return 200 with an envelope like the siblings.",
      "reason": "Observable divergence on a public endpoint: stale-client detection silently fails for this one route.",
      "scope": "cross_file",
      "affected_symbols": ["noContent", "apiJson"],
      "evidence": {
        "declaration": "function noContent(): Response { const headers = new Headers({ \"Cache-Control\": \"no-store\", \"X-Pulse-API-Version\": \"v1\" }); return new Response(null, { status: 204, headers }) }",
        "call_site": "return result.status === 204 ? noContent() : apiJson(result.body, { status: result.status })",
        "behavior": "apiJson sets Cache-Control, X-Pulse-API-Version, X-Pulse-Supported-API-Versions, X-Pulse-Minimum-CLI-Version, X-Pulse-Latest-CLI-Version"
      },
      "example": {
        "before": "return result.status === 204 ? noContent() : apiJson(...)",
        "after": "return result.status === 204 ? apiNoContent() : apiJson(...)"
      },
      "migration_risk": "Headers-only change; 204 body semantics unchanged.",
      "verification": "CONFIRMED"
    },
    {
      "file": "app/api/cron/maintenance/route.ts",
      "line": 32,
      "category": "convention",
      "severity": "medium",
      "summary": "Cron completion log events have drifted: check-monitors and check-dependencies emit cron.completed/cron.failed while maintenance and sweep emit job-prefixed events, and OPERATIONS.md's runbook searches cron.failed, missing two jobs.",
      "current": "event: failed ? \"maintenance.failed\" : \"maintenance.completed\" (and sweep.*) vs event: failed ? \"cron.failed\" : \"cron.completed\"; all four share cron.started and a jobName field",
      "proposed": "One vocabulary: generic cron.completed/cron.failed everywhere, with jobName carrying the distinction it already carries.",
      "reason": "Docs/OPERATIONS.md:22 instructs operators to inspect the cron.failed event; followed literally it returns nothing for failed maintenance or sweep runs. Git shows the prefixes were introduced independently with no reconciliation.",
      "scope": "cross_file",
      "affected_symbols": ["cron route log events"],
      "evidence": {
        "declaration": "event: failed ? \"maintenance.failed\" : \"maintenance.completed\",",
        "call_site": "event: failed ? \"cron.failed\" : \"cron.completed\",",
        "behavior": "event: \"cron.started\", jobName: \"maintenance\"  // all four routes share the start event and jobName"
      },
      "example": {
        "before": "event: failed ? \"maintenance.failed\" : \"maintenance.completed\"",
        "after": "event: failed ? \"cron.failed\" : \"cron.completed\""
      },
      "migration_risk": "Log queries watching the job-prefixed events need updating; update OPERATIONS.md in the same change.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/reporting/queries/status.ts",
      "line": 99,
      "category": "abstraction",
      "severity": "medium",
      "summary": "The failure-label policy exists four times: public copies in status.ts and status-reports.ts (one admitting the duplication in a comment), the authenticated variant in incident-shape.ts, and a fourth hand-copy in live-summary.ts.",
      "current": "failureLabel(statusCode) in status.ts, publicIncidentCause in status-reports.ts, failureLabel(errorCode, statusCode) in incident-shape.ts, openingFailure in live-summary.ts",
      "proposed": "Add publicFailureLabel(statusCode) to lib/monitoring/incident-shape.ts beside the authenticated failureLabel; import it in status.ts and status-reports.ts; point live-summary.ts at the authenticated one.",
      "reason": "One branching rule maintained in four places by hand; the public/authenticated distinction is deliberate and the fix preserves it.",
      "scope": "cross_file",
      "affected_symbols": ["failureLabel", "publicIncidentCause", "openingFailure"],
      "evidence": {
        "declaration": "function failureLabel(statusCode: number | null): string { if (statusCode !== null) { return `HTTP ${statusCode}` } ... return \"Availability check failed\" }",
        "call_site": "/** Matches the public label in lib/reporting/queries/status.ts (failureLabel). */ export function publicIncidentCause(...)",
        "behavior": "export function failureLabel(errorCode: string | null, statusCode: number | null): string { ... return errorCode ?? \"Unknown failure\" }"
      },
      "example": {
        "before": "cause: failureLabel(incident.openingStatusCode)  // local copy",
        "after": "cause: publicFailureLabel(incident.openingStatusCode)  // one shared policy"
      },
      "migration_risk": "Pure consolidation, output strings unchanged.",
      "verification": "CONFIRMED"
    },
    {
      "file": "cli/internal/command/monitorops/monitorops.go",
      "line": 767,
      "category": "abstraction",
      "severity": "medium",
      "summary": "monitorops (and groupops, dependencyops) hand-roll table/TSV renderers instead of using the shared output.Render, and the duplicated branches have already diverged: monitor list's TSV emits ID/Name/State/URL while its table emits ID/Name/State/Uptime.",
      "current": "renderEnvelope/renderList/renderWatch switching on format with hardcoded columns per resource",
      "proposed": "Route list/get output through output.Render with a column-projection transform for the curated view; keep watch's transition line custom (it has no generic equivalent).",
      "reason": "Escaping/sanitization fixes applied to output.Render silently do not reach these paths, and the format branches already disagree on columns for one command.",
      "scope": "cross_file",
      "affected_symbols": ["renderList", "renderEnvelope", "output.Render"],
      "evidence": {
        "declaration": "func renderList(d Dependencies, format string, doc ListEnvelope) error { switch format { case \"json\": ... }",
        "call_site": "return output.Render(d.Out, selected, value)  // adminops/configops already do this",
        "behavior": "monitor list TSV branch emits ID/Name/State/URL while the table branch emits ID/Name/State/Uptime"
      },
      "example": {
        "before": "return renderList(d, d.Format(), doc)",
        "after": "return output.Render(d.Out, d.Format(), projectMonitorColumns(doc))"
      },
      "migration_risk": "Needs a projection step; watch transition output stays bespoke.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/dependencies/types.ts",
      "line": 136,
      "category": "abstraction",
      "severity": "medium",
      "summary": "NormalizedProviderSnapshot widens every validated provider-incident state back to bare string, forcing an as-cast at the DB write; no exported ProviderIncidentState type exists.",
      "current": "state: string on incidents/updates/maintenances, despite adapters validating via requireProviderIncidentState",
      "proposed": "Export ProviderIncidentState from the adapters' shared module and use it in the interface; retype nextdata-embedded's three map functions (currently annotated string) in the same change.",
      "reason": "An invalid state becomes a compile error at the adapter boundary instead of relying on the DB CHECK constraint; the as-cast at the write site disappears.",
      "scope": "cross_file",
      "affected_symbols": ["NormalizedProviderSnapshot", "requireProviderIncidentState", "nextdata-embedded map functions"],
      "evidence": {
        "declaration": "state: string",
        "call_site": "state: requireProviderIncidentState(normalizeIncidentOrMaintenanceStatus(incident.status), sourceId),",
        "behavior": "state: incident.state as (typeof providerIncidents.$inferInsert)[\"state\"],"
      },
      "example": {
        "before": "state: string  // widened, cast back at write",
        "after": "state: ProviderIncidentState  // no cast needed"
      },
      "migration_risk": "nextdata-embedded needs retyping; DB constraint already backstops runtime.",
      "verification": "CONFIRMED"
    },
    {
      "file": "emails/outage.tsx",
      "line": 7,
      "category": "call_site",
      "severity": "medium",
      "summary": "All five email templates interpolate raw ISO 8601 strings into human-facing copy (recipients see 'Started 2026-07-21T10:10:00.000Z'), while the sibling duration field in the same payload is formatted via formatDuration.",
      "current": "startedAt: string props fed by Date.toISOString(), rendered raw in outage, recovery, dependency-incident, dependency-recovery, system-alert templates",
      "proposed": "Add a formatEmailTimestamp helper applied at the render boundary in lib/notifications/message.tsx (status page timestamps stay UTC per repo convention).",
      "reason": "The pipeline already formats duration, proving the convention exists and was omitted for timestamps; nothing in the prop name warns the value is machine-format.",
      "scope": "cross_file",
      "affected_symbols": ["OutageEmail", "RecoveryEmail", "DependencyIncidentEmail", "DependencyRecoveryEmail", "SystemAlertEmail"],
      "evidence": {
        "declaration": "startedAt: string",
        "call_site": "startedAt={payload.startedAt}",
        "behavior": "startedAt: openedAt.toISOString(),  // raw through zod nonempty-string, no transform anywhere"
      },
      "example": {
        "before": "<Text style={emailMetaStyle}>Started {startedAt}</Text>",
        "after": "<Text style={emailMetaStyle}>Started {formatEmailTimestamp(startedAt)}</Text>"
      },
      "migration_risk": "Display-only change to outbound emails.",
      "verification": "CONFIRMED"
    },
    {
      "file": "emails/dependency-incident.tsx",
      "line": 34,
      "category": "domain_language",
      "severity": "medium",
      "summary": "Dependency emails print the raw enum ('State OUTAGE') while the dashboard always humanizes via dependencyStateLabels; the same bug is in dependency-recovery.tsx.",
      "current": "<Text style={emailMetaStyle}>State {state}</Text> with state = the literal DependencyState value",
      "proposed": "Humanize via dependencyStateLabels before the template (the module has no 'use client' directive, so the server email path can import it), or carry a pre-humanized label in the payload.",
      "reason": "Email is the only surface showing shouting-case enum text to users.",
      "scope": "cross_file",
      "affected_symbols": ["DependencyIncidentEmail", "DependencyRecoveryEmail", "dependencyStateLabels"],
      "evidence": {
        "declaration": "state: string  // in DependencyIncidentEmailProps",
        "call_site": "state={payload.state}",
        "behavior": "export const dependencyStateLabels: Record<DependencyState, string> = { OPERATIONAL: \"Operational\", ... OUTAGE: \"Outage\", ... }"
      },
      "example": {
        "before": "state={payload.state}  // renders State OUTAGE",
        "after": "state={dependencyStateLabels[payload.state]}  // renders State Outage"
      },
      "migration_risk": "Display-only.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/scheduler/coordinator.ts",
      "line": 47,
      "category": "value_naming",
      "severity": "medium",
      "summary": "The same reconciled-claim count from one underlying function is spelled staleClaims in two pipelines and staleClaimsReconciled in the third, with the sweep route renaming it back just to log it.",
      "current": "staleClaims: number (coordinator.ts, dependencies/runtime.ts) vs staleClaimsReconciled: number (maintenance/runtime.ts) plus a rename-on-log in sweep/route.ts",
      "proposed": "Standardize on staleClaimsReconciled everywhere and drop the log rename.",
      "reason": "A bare plural noun holding a number reads as a collection; one concept, two spellings, four sites.",
      "scope": "cross_file",
      "affected_symbols": ["staleClaims", "staleClaimsReconciled", "SystemAlertDeliverySummary"],
      "evidence": {
        "declaration": "staleClaims: number",
        "call_site": "staleClaims: systemAlertDelivery.staleClaimsReconciled,",
        "behavior": "export type SystemAlertDeliverySummary = DeliverySummary & { staleClaimsReconciled: number }"
      },
      "example": {
        "before": "staleClaims: systemAlertDelivery.staleClaimsReconciled,",
        "after": "staleClaimsReconciled: systemAlertDelivery.staleClaimsReconciled,"
      },
      "migration_risk": "Log key changes; nothing pins it.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/storage/batch.ts",
      "line": 79,
      "category": "simplification",
      "severity": "medium",
      "summary": "writePackedMinute reads as the live per-minute batch writer but has zero production callers; the scheduler uses the more complete persistAtomicMinute, so changes here silently do not affect production.",
      "current": "export writePackedMinute + WRITE_PACKED_MINUTE_SQL, imported only by their own test (atomic-minute.ts imports only the executor type)",
      "proposed": "Delete writePackedMinute, WRITE_PACKED_MINUTE_SQL, and their test.",
      "reason": "The name promises the packed-minute write path; a knip sweep missed it because the self-test counts as usage.",
      "scope": "local",
      "affected_symbols": ["writePackedMinute", "WRITE_PACKED_MINUTE_SQL"],
      "evidence": {
        "declaration": "export async function writePackedMinute(db: PackedMinuteExecutor, input: PackedMinuteInput): Promise<void> {",
        "call_site": "await writePackedMinute({ query }, { scheduledMinute: ..., ... })  // batch.test.ts, the only caller",
        "behavior": "scheduler runtime calls persistAtomicMinute, which performs the same writes plus incident lifecycle, outbox, and an atomicity assertion"
      },
      "example": {
        "before": "writePackedMinute exported beside persistAtomicMinute",
        "after": "persistAtomicMinute is the single write path"
      },
      "migration_risk": "None, zero production callers.",
      "verification": "CONFIRMED"
    },
    {
      "file": "cli/internal/command/adminops/adminops.go",
      "line": 471,
      "category": "convention",
      "severity": "medium",
      "summary": "adminops' shared annotations() omits jsonl from supportsOutput, so token list's introspection manifest under-declares a format that actually works, while every sibling ops package declares it.",
      "current": "supportsOutput: \"table,json,yaml,tsv\" for all adminops commands; token list --output jsonl succeeds today despite the manifest",
      "proposed": "Extend the single shared annotations() to \"table,json,jsonl,yaml,tsv\", matching how every other ops package applies one helper to all commands.",
      "reason": "Tested manifest-vs-behavior divergence: scripts driving pulsectl off the manifest wrongly conclude token list cannot stream jsonl.",
      "scope": "public_api",
      "affected_symbols": ["adminops.annotations"],
      "evidence": {
        "declaration": "func annotations(scope string) map[string]string { return map[string]string{\"requiredScope\": scope, \"supportsOutput\": \"table,json,yaml,tsv\"} }",
        "call_site": "cmd := &cobra.Command{Use: \"list\", Short: \"List scoped tokens\", ..., Annotations: annotations(\"tokens:manage\"), ...}",
        "behavior": "sibling packages: return map[string]string{\"supportsOutput\": \"table,json,jsonl,yaml,tsv\", \"requiredScope\": scope}"
      },
      "example": {
        "before": "\"supportsOutput\": \"table,json,yaml,tsv\"",
        "after": "\"supportsOutput\": \"table,json,jsonl,yaml,tsv\""
      },
      "migration_risk": "Manifest-only change; behavior already supports jsonl.",
      "verification": "CONFIRMED"
    },
    {
      "file": "app/(auth)/onboarding/onboarding-flow.tsx",
      "line": 130,
      "category": "value_naming",
      "severity": "medium",
      "summary": "One boolean travels through the component under three names: the alertsDisabled prop seeds emailWarningAcknowledged state, which is passed as acknowledgeEmailWarning to one child and alertsDisabled to another.",
      "current": "alertsDisabled (prop) -> emailWarningAcknowledged (state) -> acknowledgeEmailWarning / alertsDisabled (child props), provably one value on every path",
      "proposed": "Unify the prop and state under one name; keep acknowledgeEmailWarning only at the Account/API handoff, where it matches the server contract field.",
      "reason": "Three vocabulary hops for one boolean make the data flow look richer than it is; the API-boundary name is the only justified variant.",
      "scope": "local",
      "affected_symbols": ["OnboardingFlow props/state", "Account", "VerifyStep"],
      "evidence": {
        "declaration": "interface Props { ...; alertsDisabled?: boolean }",
        "call_site": "<Account acknowledgeEmailWarning={emailWarningAcknowledged} ...",
        "behavior": "<VerifyStep alertsDisabled={emailWarningAcknowledged} ..."
      },
      "example": {
        "before": "<Account acknowledgeEmailWarning={emailWarningAcknowledged} /> ... <VerifyStep alertsDisabled={emailWarningAcknowledged} />",
        "after": "<Account emailAlertsUnavailable={emailAlertsUnavailable} /> ... <VerifyStep emailAlertsUnavailable={emailAlertsUnavailable} />"
      },
      "migration_risk": "Local to the onboarding flow; keep the POST body field name unchanged.",
      "verification": "CONFIRMED"
    },
    {
      "file": "components/settings/security-settings.tsx",
      "line": 43,
      "category": "simplification",
      "severity": "medium",
      "summary": "formatSignedIn and formatExpiry are byte-identical date formatters in two Settings files that both already import from the shared formatting module.",
      "current": "Identical Intl.DateTimeFormat bodies under two names in security-settings.tsx and access-settings.tsx",
      "proposed": "One formatShortDate(value, timeZone) in lib/reporting/format.ts, called from both.",
      "reason": "Two names for one behavior; a formatting change must be made twice or the views drift.",
      "scope": "cross_file",
      "affected_symbols": ["formatSignedIn", "formatExpiry"],
      "evidence": {
        "declaration": "function formatSignedIn(value: string, timeZone: string): string { ... new Intl.DateTimeFormat(\"en-US\", { day: \"numeric\", month: \"short\", year: \"numeric\", timeZone }) ... }",
        "call_site": "{formatExpiry(token.expiresAt, resolvedTimeZone)}",
        "behavior": "function formatExpiry(...) has the identical body in access-settings.tsx"
      },
      "example": {
        "before": "{formatSignedIn(session.createdAt, resolvedTimeZone)}",
        "after": "{formatShortDate(session.createdAt, resolvedTimeZone)}"
      },
      "migration_risk": "None, display helpers only.",
      "verification": "CONFIRMED"
    },
    {
      "file": "components/settings/settings-dirty.tsx",
      "line": 85,
      "category": "simplification",
      "severity": "medium",
      "summary": "GuardedLink is a provably inert identity wrapper around next/link (the guard is a document-wide capture-phase listener), and its name invites adding confirm logic that the comment itself says would double-prompt.",
      "current": "export function GuardedLink(props) { return <Link {...props} /> }",
      "proposed": "Delete GuardedLink; use next/link directly at its two call sites.",
      "reason": "The repo's own test shows a plain anchor gets the identical dialog while dirty; the wrapper adds no behavior and misleads about where the guard lives.",
      "scope": "cross_file",
      "affected_symbols": ["GuardedLink"],
      "evidence": {
        "declaration": "export function GuardedLink(props: React.ComponentProps<typeof Link>) { return <Link {...props} /> }",
        "call_site": "<GuardedLink href=\"/status\">View status page</GuardedLink>",
        "behavior": "comment: the unsaved-changes confirm is provided globally by SettingsDirtyProvider's useNavigationGuard (a document-wide click listener), so this component must not add its own confirm"
      },
      "example": {
        "before": "<GuardedLink href=\"/status\">View status page</GuardedLink>",
        "after": "<Link href=\"/status\">View status page</Link>"
      },
      "migration_risk": "Two call sites plus tests.",
      "verification": "CONFIRMED"
    },
    {
      "file": "components/incidents/report-editor.tsx",
      "line": 507,
      "category": "function_naming",
      "severity": "low",
      "summary": "destroyReport (and report-row-actions' destroy) are the only uses of destroy for an operation every other layer calls delete (deleteUpdate, deleteStatusReport, CLI report delete).",
      "current": "async function destroyReport() alongside async function deleteUpdate(updateId) in the same file",
      "proposed": "Rename to deleteReport (and report-row-actions' handler to remove the destroy outlier).",
      "reason": "One vocabulary for one operation; grep for delete then finds all deletions.",
      "scope": "cross_file",
      "affected_symbols": ["destroyReport", "report-row-actions destroy"],
      "evidence": {
        "declaration": "async function destroyReport() {",
        "call_site": "async function deleteUpdate(updateId: string) {",
        "behavior": "await apiRequest(`/api/v1/status-reports/${encodeURIComponent(report.id)}`, { method: \"DELETE\" }, true)"
      },
      "example": {
        "before": "async function destroyReport() { ... }",
        "after": "async function deleteReport() { ... }"
      },
      "migration_risk": "Private component functions.",
      "verification": "CONFIRMED"
    },
    {
      "file": "cli/internal/command/monitorops/monitorops.go",
      "line": 313,
      "category": "call_site",
      "severity": "low",
      "summary": "editBody and addEditFlags take a bare create bool passed as unlabeled true/false, which switches whether fields are unconditional or gated on Changed().",
      "current": "editBody(cmd, f, create bool) called as editBody(cmd, f, true) / editBody(cmd, f, false)",
      "proposed": "A named mode value (small const/enum) rather than a split: ~85 lines are shared and only the id/gating differs.",
      "reason": "The boolean's meaning is invisible at four call sites.",
      "scope": "local",
      "affected_symbols": ["editBody", "addEditFlags"],
      "evidence": {
        "declaration": "func editBody(cmd *cobra.Command, f editFlags, create bool) (map[string]any, error) {",
        "call_site": "body, err := editBody(cmd, f, false)",
        "behavior": "put := func(flag, key string, value any) { if create || cmd.Flags().Changed(flag) {"
      },
      "example": {
        "before": "body, err := editBody(cmd, f, true)",
        "after": "body, err := editBody(cmd, f, editModeCreate)"
      },
      "migration_risk": "Local to the file.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/dependencies/adapters/incident-feed.ts",
      "line": 38,
      "category": "value_naming",
      "severity": "low",
      "summary": "MarkerInfo carries the generic Info suffix in a file whose every other identifier says marker.",
      "current": "interface MarkerInfo { state: ProviderIncidentState; resolved: boolean }",
      "proposed": "Rename to StatusMarker.",
      "reason": "Matches STATUS_MARKERS, MARKER_TOKEN, DEFAULT_ACTIVE_MARKER; unexported, zero external uses.",
      "scope": "local",
      "affected_symbols": ["MarkerInfo"],
      "evidence": {
        "declaration": "interface MarkerInfo { state: ProviderIncidentState; resolved: boolean }",
        "call_site": "const STATUS_MARKERS: Record<string, MarkerInfo> = { RESOLVED: { state: \"resolved\", resolved: true },",
        "behavior": "const DEFAULT_ACTIVE_MARKER: MarkerInfo = { state: DEFAULT_ACTIVE_STATE, resolved: false }"
      },
      "example": {
        "before": "const STATUS_MARKERS: Record<string, MarkerInfo> = {",
        "after": "const STATUS_MARKERS: Record<string, StatusMarker> = {"
      },
      "migration_risk": "None.",
      "verification": "CONFIRMED"
    },
    {
      "file": "components/dependencies/dependency-detail.tsx",
      "line": 19,
      "category": "simplification",
      "severity": "low",
      "summary": "formatTimestamp is byte-identical in dependency-detail.tsx and monitor-detail.tsx; both files already import from lib/reporting/format.ts.",
      "current": "Two identical local Intl.DateTimeFormat helpers",
      "proposed": "One formatShortTimestamp in lib/reporting/format.ts, imported by both.",
      "reason": "The shared module is the established home; the copies will drift on any change.",
      "scope": "cross_file",
      "affected_symbols": ["formatTimestamp (x2)"],
      "evidence": {
        "declaration": "function formatTimestamp(value: string, timeZone: string): string { return new Intl.DateTimeFormat(\"en-US\", { month: \"short\", day: \"numeric\", hour: \"2-digit\", minute: \"2-digit\", hour12: false, timeZone }).format(new Date(value)) }",
        "call_site": "{formatTimestamp(activeIncident.startedAt, resolvedTimeZone)}",
        "behavior": "components/monitors/monitor-detail.tsx:127 defines the identical body verbatim"
      },
      "example": {
        "before": "local formatTimestamp in each detail component",
        "after": "import { formatShortTimestamp } from \"@/lib/reporting/format\""
      },
      "migration_risk": "None.",
      "verification": "CONFIRMED"
    },
    {
      "file": "cli/internal/command/dependencyops/dependencyops.go",
      "line": 163,
      "category": "value_naming",
      "severity": "low",
      "summary": "CatalogData is the file's only Data-suffixed type, wrapping exactly the domain noun the rest of the codebase calls Catalog.",
      "current": "type CatalogData struct { Categories []CatalogCategory }",
      "proposed": "type Catalog struct { Categories []CatalogCategory }",
      "reason": "Data adds nothing; zero references outside the file, no generated-code constraint.",
      "scope": "local",
      "affected_symbols": ["CatalogData"],
      "evidence": {
        "declaration": "type CatalogData struct {",
        "call_site": "func flattenCatalog(data CatalogData) []CatalogPreset {",
        "behavior": "var data CatalogData; if err := json.Unmarshal(doc.Data, &data); err != nil {"
      },
      "example": {
        "before": "func flattenCatalog(data CatalogData) []CatalogPreset {",
        "after": "func flattenCatalog(data Catalog) []CatalogPreset {"
      },
      "migration_risk": "None.",
      "verification": "CONFIRMED"
    },
    {
      "file": "app/api/v1/cli-auth/revoke/route.ts",
      "line": 11,
      "category": "value_naming",
      "severity": "low",
      "summary": "The only one of 54 authorize() call sites that binds the ApiContext | Response union to authorized instead of context, reading as a boolean.",
      "current": "const authorized = await authorize(request)",
      "proposed": "Bind to context; note the file already declares a second const context at line 18, so the fix merges the two declarations rather than find-replacing.",
      "reason": "53 of 54 call sites establish the pattern; the outlier obscures that the value carries the full context.",
      "scope": "local",
      "affected_symbols": ["cli-auth/revoke POST"],
      "evidence": {
        "declaration": "const authorized = await authorize(request)",
        "call_site": "const context = await authorize(request, { scope: \"monitors:read\" })  // every other route",
        "behavior": "if (isApiResponse(authorized) && !replay) { return authorized }"
      },
      "example": {
        "before": "const authorized = await authorize(request)",
        "after": "const context = await authorize(request)  // merged with the replay-reconstruction declaration"
      },
      "migration_risk": "Requires merging with the existing second declaration.",
      "verification": "CONFIRMED"
    },
    {
      "file": "app/api/v1/dependencies/route.ts",
      "line": 12,
      "category": "abstraction",
      "severity": "low",
      "summary": "The dependencies POST zod schema lives inline in route.ts against the repo-wide colocated-schema convention; dependency-http.ts imports zod solely to catch errors from validation it does not perform, and lib/dependencies/service.ts already exports the input type this schema should satisfy.",
      "current": "const createSchema = z.object({...}).strict() in route.ts; same pattern in notifications/test/route.ts",
      "proposed": "Move createSchema into lib/api/dependency-http.ts (or the dependencies service module) and import it.",
      "reason": "Monitors, groups, account, tokens, and config all colocate schemas with their lib/api modules; the split was started here and never finished.",
      "scope": "cross_file",
      "affected_symbols": ["createSchema", "dependency-http.ts"],
      "evidence": {
        "declaration": "const createSchema = z.object({ presetId: z.string().min(1), scopeId: z.string().min(1).optional(), notificationsEnabled: z.boolean().optional() }).strict()",
        "call_site": "if (error instanceof z.ZodError) { return apiError(requestId, 400, \"INVALID_REQUEST\", ...) }  // dependency-http.ts",
        "behavior": "const parsed = createSchema.parse(body)"
      },
      "example": {
        "before": "const createSchema = z.object({...}) // in route.ts",
        "after": "import { createDependencySchema } from \"@/lib/api/dependency-http\""
      },
      "migration_risk": "Organizational only.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/reporting/format.ts",
      "line": 87,
      "category": "simplification",
      "severity": "low",
      "summary": "The same-calendar-day-in-zone check exists twice: an inline dayOf closure in formatRelativeTime and the exported sameDayInZone in incident-format.ts, verified byte-identical in output across timezones and DST boundaries.",
      "current": "const dayOf = (date) => date.toLocaleDateString(\"en-CA\", { timeZone }) vs exported sameDayInZone using Intl.DateTimeFormat en-CA",
      "proposed": "Move sameDayInZone into lib/reporting/format.ts (incident-format.ts already imports from it, no cycle) and have formatRelativeTime call it.",
      "reason": "Two implementations of one domain concept in files that share an import edge.",
      "scope": "cross_file",
      "affected_symbols": ["formatRelativeTime", "sameDayInZone"],
      "evidence": {
        "declaration": "const dayOf = (date: Date) => date.toLocaleDateString(\"en-CA\", { timeZone })",
        "call_site": "if (sameDayOf && sameDayInZone(value, sameDayOf, resolvedTimeZone)) {",
        "behavior": "export function sameDayInZone(a: string, b: string, timeZone = \"UTC\"): boolean { ... Intl.DateTimeFormat(\"en-CA\", ...) }"
      },
      "example": {
        "before": "if (dayOf(value) === dayOf(now)) {",
        "after": "if (sameDayInZone(value.toISOString(), now.toISOString(), timeZone)) {"
      },
      "migration_risk": "None, outputs verified identical.",
      "verification": "CONFIRMED"
    },
    {
      "file": "lib/database-health/repository.ts",
      "line": 271,
      "category": "call_site",
      "severity": "low",
      "summary": "The sole MEASURE_USAGE_SQL call passes three unlabeled null literals binding to three semantically unrelated nullable fields.",
      "current": "portableQueryValues([now, DATABASE_STORAGE_BUDGET_BYTES, null, null, null])",
      "proposed": "Name each null as a local const: providerReportedTotalBytes ($3, from which history_bytes is derived), monthlyTransferBytes ($4), providerMetricsCapturedAt ($5).",
      "reason": "A maintainer adding a parameter has nothing to check the array against except counting SQL placeholders by hand.",
      "scope": "local",
      "affected_symbols": ["measureUsage call site"],
      "evidence": {
        "declaration": "export const MEASURE_USAGE_SQL = `with relations as (",
        "call_site": "portableQueryValues([now, DATABASE_STORAGE_BUDGET_BYTES, null, null, null])",
        "behavior": "$4::bigint, projected_bytes, governor_mode, (select max(compacted_at) from metric_rollups), scheduler_coverage, $5::timestamptz"
      },
      "example": {
        "before": "portableQueryValues([now, DATABASE_STORAGE_BUDGET_BYTES, null, null, null])",
        "after": "portableQueryValues([now, DATABASE_STORAGE_BUDGET_BYTES, providerReportedTotalBytes, monthlyTransferBytes, providerMetricsCapturedAt])"
      },
      "migration_risk": "None.",
      "verification": "CONFIRMED"
    },
    {
      "file": "components/settings/monitoring-health.tsx",
      "line": 16,
      "category": "domain_language",
      "severity": "low",
      "summary": "File and component say monitoring-health but the card renders 'Monitoring Loop' and the domain modules are loop-health.ts / loop-alert.ts; the sibling DatabaseHealthCard is three-way consistent.",
      "current": "MonitoringHealthCard in monitoring-health.tsx rendering <CardTitle>Monitoring Loop</CardTitle>",
      "proposed": "Rename to loop-health.tsx / MonitoringLoopCard so file, component, and copy agree.",
      "reason": "A reader following the import must know the rename happens at render time; one import site.",
      "scope": "local",
      "affected_symbols": ["MonitoringHealthCard"],
      "evidence": {
        "declaration": "export function MonitoringHealthCard({ warnings }: { warnings: HealthWarning[] }) {",
        "call_site": "import { MonitoringHealthCard } from \"@/components/settings/monitoring-health\"",
        "behavior": "<CardTitle>Monitoring Loop</CardTitle>"
      },
      "example": {
        "before": "import { MonitoringHealthCard } from \"@/components/settings/monitoring-health\"",
        "after": "import { MonitoringLoopCard } from \"@/components/settings/loop-health\""
      },
      "migration_risk": "One import.",
      "verification": "CONFIRMED"
    },
    {
      "file": "cli/internal/buildinfo/version.go",
      "line": 7,
      "category": "simplification",
      "severity": "low",
      "summary": "Commit and Date are declared and defaulted to \"unknown\" but nothing reads them and no build path (-X ldflags, Makefile, goreleaser, CI) ever sets them.",
      "current": "var ( Version = ...; Commit = \"unknown\"; Date = \"unknown\" )",
      "proposed": "Remove Commit and Date, or wire them into the version command and a build script in the same change.",
      "reason": "Unfinished build-stamping scaffolding is surface a reader must rule out.",
      "scope": "local",
      "affected_symbols": ["buildinfo.Commit", "buildinfo.Date"],
      "evidence": {
        "declaration": "var (\n\tVersion = \"0.2.1\"\n\tCommit  = \"unknown\"\n\tDate    = \"unknown\"\n)",
        "call_site": "data := map[string]any{\"cliVersion\": d.LocalVersion}",
        "behavior": "return \"pulsectl/\" + Version + \" (\" + runtime.GOOS + \"; \" + runtime.GOARCH + \")\"  // only Version is read; CI runs plain go build"
      },
      "example": {
        "before": "var ( Version, Commit, Date )",
        "after": "var Version = \"0.2.1\""
      },
      "migration_risk": "None.",
      "verification": "CONFIRMED"
    }
  ],
  "appendix": [
    {"file": "lib/maintenance/coordinator.ts", "line": 276, "summary": "performMaintenance's 326-line body uses numbered comments as phase markers; extraction has value but phases share budget/cutoff state, so the decomposition needs design judgment.", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "cli/internal/command/readops/readops.go", "line": 138, "summary": "Pagination loop, hostile-server bounds, and helpers copy-pasted across five ops packages with unprincipled signature drift (positional vs ListOptions); a shared listpage package would fix it but is architectural. Would elevate: any behavioral divergence between the copies.", "scope": "architectural", "verification": "PLAUSIBLE"},
    {"file": "cli/internal/command/configops/configops.go", "line": 216, "summary": "apply's RunE mixes two confirmation policies with transport, but the same inline confirm idiom is the established convention in 7+ command files; fixing one file alone adds inconsistency.", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "lib/monitoring/process-check.ts", "line": 113, "summary": "applyTransition's three store-operation branches could be named (openIncident/resolveIncident/recordIncidentProgress); single call site, accurate name, judgment call.", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "lib/api/monitor-http.ts", "line": 23, "summary": "monitorError(...) ?? routeError(...) fallback duplicated 6 times; a handleMonitorRouteError wrapper removes the forgettable null contract. Would elevate: a route that actually forgot the fallback.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "lib/api/monitor-http.ts", "line": 54, "summary": "storedMonitorError re-implements monitorErrorStatus's ternary in the same file; sibling group-http.ts shows the reuse pattern. Fix is behaviorally exact (treat 503 sentinel as not-stored).", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "app/api/v1/config/apply/route.ts", "line": 63, "summary": "Config error-status mapping inlined in apply and plan routes against the monitorErrorStatus/dependencyErrorStatus precedent; the apparent 400-vs-500 drift is dead code from plan's perspective, so DRY value only.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "app/api/v1/monitors/route.ts", "line": 30, "summary": "Monitor-state array byte-identical to lib/api/monitors.ts's unexported STATE_ORDER (a deliberate severity sort); export STATE_ORDER and import it in the route for the ?state= validation.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "lib/notifications/sql.ts", "line": 190, "summary": "reconcileStaleClaims' positional staleAfterMs forces bare undefined at both cron call sites; merging into the options object touches ~6 call sites including tests.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "lib/api/operational-service.ts", "line": 68, "summary": "OperationalService bundles incidents, status, and test notifications behind a vague name; the bundling is an intentional DI seam, but 3 of 4 tests need an unused getStatus stub. Would elevate: a fourth unrelated method joining the bundle.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "components/incidents/report-editor.tsx", "line": 140, "summary": "busy holds string|null and needs a derived anyBusy; repo has two coexisting conventions (xBusy string|null vs pendingMonitorId), which are orthogonal families (mutation gates vs navigation hints), so no single rename is proven right.", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "components/dashboard/monitor-table.tsx", "line": 101, "summary": "pendingMonitorId vs the 10-declaration xBusy family: semantically distinct (8s timer navigation hint, gates nothing), so unification in either direction is a judgment call.", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "components/status-page/status-page-content.tsx", "line": 524, "summary": "groupView boolean prop could read as a predicate (singleGroup); accurate today, micro-readability only.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "lib/notifications/sql.ts", "line": 216, "summary": "markNotificationSent takes trailing positionals while markNotificationFailed takes an options object for the same claim-completion path; original design, types prevent argument swaps.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "lib/reporting/queries/monitors.ts", "line": 297, "summary": "7/30/90-day windows as inline millisecond arithmetic at 10 sites in a file that already names its other *_MS constants.", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "lib/notifications/provider.ts", "line": 41, "summary": "One opaque literal false for NotificationProviderError's retryable flag; an { retryable } options arg or comment suffices, factories are oversized.", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "cli/internal/command/integration.go", "line": 327, "summary": "contextEnvelope hardcodes true where three sibling sites derive the current flag; the literal is provably correct today, stylistic consistency only.", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "openapi/service.openapi.yaml", "line": 4925, "summary": "AffectedService.groupName vs Monitor.group for the identical concept; blast radius is small (2 spec lines, one Go struct tag, and it removes an alias) but it is an unversioned public-API break. Would elevate: an API versioning story.", "scope": "public_api", "verification": "PLAUSIBLE"},
    {"file": "lib/api/monitors.ts", "line": 193, "summary": "Public monitor field group holds a group NAME; deliberate repo-wide convention (legacy input, query filter, v1->v2 upgrade), rename only worth doing at a version boundary.", "scope": "public_api", "verification": "PLAUSIBLE"},
    {"file": "components/settings/monitor-sheet.tsx", "line": 437, "summary": "submit() and archive() duplicate the delayed refresh+close triplet (10s vs 800ms); 3-line block used twice, AGENTS.md weighs against extraction machinery.", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "app/api/v1/tokens/route.ts", "line": 75, "summary": "routeKey strings use three conventions (path literals, hyphen slugs, config.apply's dot slug); purely cosmetic since the replay decision compares requestHash, not routeKey.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "components/monitors/use-monitor-live.ts", "line": 20, "summary": "Hand-rolled live fetcher parallel to apiRequest with duck-type-identical error types; consolidate or document why polling bypasses the shared fetcher.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "lib/checker/validation.ts", "line": 80, "summary": "validateMonitorConfig is an exported dead function whose internal schema lacks displayName()'s control-character rejection; the schema itself was already de-exported by a prior sweep. Delete or rebuild from displayName().", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "app/api/v1/status-page-config/route.ts", "line": 88, "summary": "PUT hand-rolls the idempotent-mutation orchestration runStatusReportMutation encapsulates; git shows double-touch maintenance (2 commits editing both), but ETag/If-Match asymmetry means the shared helper needs a raw-result design first.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "lib/dependencies/persist.ts", "line": 209, "summary": "Adapter-name literal branches in 3 shared files (incidentio_compat, google_cloud_status, incident_feed) instead of registry capability fields; the Google case needs a function-valued capability, not a flag.", "scope": "architectural", "verification": "PLAUSIBLE"},
    {"file": "lib/storage/atomic-minute.ts", "line": 396, "summary": "Inline quarter-hour arithmetic predates the named completesQuarterHourBucket predicate in the same package; call the predicate (no import cycle).", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "lib/notifications/enqueue.ts", "line": 58, "summary": "Ternary duplicates six payload fields to vary one type tag; single-object form typechecks cleanly, but the claimed silent-divergence risk does not hold under the existing annotation. Minor DRY.", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "app/api/cron/check-monitors/route.ts", "line": 13, "summary": "Cron 401 guard byte-identical (md5-matched) in five routes; a requireCronAuthorization(request): Response | null helper matches existing guard conventions.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "lib/reporting/queries/monitors.postgres.test.ts", "line": 22, "summary": "Three Postgres tests hardcode migration subsets while a sibling uses readdir().sort() with a staleness warning; subsets are currently exact for the tables exercised, so forward-looking hardening only.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "components/status-page/status-page-content.tsx", "line": 182, "summary": "Report-tier tint/dot presentation declared as two index-aligned maps duplicating overall-banner.tsx's record; byte-identical today, consolidate into one exported tier presentation record.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "lib/reporting/queries/monitors.ts", "line": 44, "summary": "Histogram bucket bounds and count hand-copied from lib/storage/histogram.ts (unexported) into the p95 decoder; export and import to make encoder/decoder drift a compile error.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "app/status/reports/[reportId]/page.tsx", "line": 61, "summary": "phaseLabels lives in the page instead of lib/status-page/reports-display.ts with its sibling enum-label maps, and 'Window ended' is re-typed as a literal in status-page-content.tsx.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "cli/internal/output/render.go", "line": 120, "summary": "Generic renderer's column-priority list hardcodes domain fields from three resources; currently inert (no consumer contains them), pass preferred columns as a Render option when it matters.", "scope": "architectural", "verification": "PLAUSIBLE"},
    {"file": "scripts/query-performance/src/fixture-constants.ts", "line": 14, "summary": "isFixtureMonitorId exported but only its own test calls it; scripts re-derive the prefix inline. Delete or add the real call site.", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "app/api/v1/monitors/route.test.ts", "line": 9, "summary": "Identical vi.mock of @/lib/api/middleware retyped in 24 route tests; both centralization paths (manual __mocks__, setupFiles factory with local override) verified to work.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "components/settings/settings-api.ts", "line": 73, "summary": "generatedMonitorId/generatedGroupId identical slug algorithm differing only in fallback word; one generatedSlugId(name, fallback).", "scope": "local", "verification": "PLAUSIBLE"},
    {"file": "components/incidents/incident-format.ts", "line": 41, "summary": "formatIncidentDuration wraps formatDuration with a clamp formatDuration already performs; inline the direct call at three call sites.", "scope": "cross_file", "verification": "PLAUSIBLE"},
    {"file": "lib/api/index.ts", "line": 1, "summary": "Ten-line export * barrel with zero importers across every import form; delete it.", "scope": "cross_file", "verification": "PLAUSIBLE"}
  ]
}
```

### Process notes

- **Verification was genuinely adversarial**: 15 of 93 candidates were refuted outright (including plausible-sounding ones like renaming `OutageEmail`, the `state`/`status` rule, and the `StatusReportDeleted` kind — killed on public-API break cost after the verifier found the OpenAPI `const` and three CLI hardcodings), and many more were downgraded to PLAUSIBLE for lacking proven divergence. Several verifiers corrected finder evidence (one fabricated quote caught and refuted, several line numbers and counts fixed).
- **One agent incident**: the Round 2 removal finder wedged itself brute-forcing a per-export importer scan; per your standing guidance I probed once, killed it, cleaned up its orphaned background loop, and relaunched with a bounded method. One Round 3 verifier died on the session limit and was relaunched to completion.
- The full working set (map, briefs, per-round candidates, and verdicts) is preserved under the session scratchpad at `scratchpad/review/` if you want to trace any finding's provenance.
