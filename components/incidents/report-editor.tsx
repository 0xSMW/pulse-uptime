"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, type ApiEnvelope } from "@/components/settings/settings-api";

import { IncidentTime } from "./incident-time";
import { ReportDraftBadge, ReportStatusChip, ReportTypeChip } from "./report-badges";
import { setReportEditorDirty } from "./report-editor-dirty";
import { messageForReportError } from "./report-errors";
import {
  BEFORE_START_COPY,
  fromDatetimeLocal,
  impactOptions,
  isBeforeStart,
  REPORT_STATUS_LABELS,
  REPORT_STATUSES,
  STATE_FLIP_COPY,
  stateFlipAfterRemoval,
  stateFlipDirection,
  toDatetimeLocal,
  validateReportForm,
  type ReportData,
  type ReportFormErrors,
  type ReportImpact,
  type ReportType,
  type ReportUpdateStatus,
  type StateFlipDirection,
} from "./report-status";

export type ReportEditorMonitor = { id: string; name: string; group: string | null };

type ImpactValue = ReportImpact | "none";

type EditingUpdate = {
  id: string;
  status: ReportUpdateStatus;
  markdown: string;
  publishedAt: string;
  warning: StateFlipDirection | null;
  error: string;
};

type Message = { text: string; tone: "info" | "error" };

const textareaClass =
  "w-full resize-y rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 font-data text-[13px] aria-invalid:border-[var(--down-text)]";

function initialImpacts(report: ReportData | null): Record<string, ImpactValue> {
  const impacts: Record<string, ImpactValue> = {};
  for (const row of report?.affected ?? []) impacts[row.monitorId] = row.impact;
  return impacts;
}

type EditorBaseline = {
  title: string;
  startsAt: string;
  endsAt: string;
  impacts: Record<string, ImpactValue>;
};

/** Order-independent signature of the affected picks, ignoring "none" rows. */
function impactSignature(impacts: Record<string, ImpactValue>): string {
  return JSON.stringify(
    Object.entries(impacts)
      .filter((entry) => entry[1] !== "none")
      .sort((left, right) => left[0].localeCompare(right[0])),
  );
}

export function ReportEditor({ report, monitors }: { report: ReportData | null; monitors: ReportEditorMonitor[] }) {
  const router = useRouter();
  const [baseline, setBaseline] = useState<EditorBaseline>(() => ({
    title: report?.title ?? "",
    startsAt: toDatetimeLocal(report?.startsAt ?? new Date().toISOString()),
    endsAt: report?.endsAt ? toDatetimeLocal(report.endsAt) : "",
    impacts: initialImpacts(report),
  }));
  const [title, setTitle] = useState(baseline.title);
  const [type, setType] = useState<ReportType>(report?.type ?? "incident");
  const [startsAt, setStartsAt] = useState(baseline.startsAt);
  const [endsAt, setEndsAt] = useState(baseline.endsAt);
  const [impacts, setImpacts] = useState<Record<string, ImpactValue>>(baseline.impacts);
  const [draft, setDraft] = useState(false);
  const [composerStatus, setComposerStatus] = useState<ReportUpdateStatus>(
    report ? report.currentStatus : REPORT_STATUSES[type][0],
  );
  const [composerMarkdown, setComposerMarkdown] = useState("");
  const [composerPublishedAt, setComposerPublishedAt] = useState(() => toDatetimeLocal(new Date().toISOString()));
  const [errors, setErrors] = useState<ReportFormErrors>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [editing, setEditing] = useState<EditingUpdate | null>(null);
  const [confirmDeleteUpdateId, setConfirmDeleteUpdateId] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const basicsDirty =
    title !== baseline.title
    || startsAt !== baseline.startsAt
    || (type === "maintenance" && endsAt !== baseline.endsAt);
  const affectedDirty = impactSignature(impacts) !== impactSignature(baseline.impacts);
  const composerDirty = composerMarkdown.trim() !== "";
  const editingDirty = useMemo(() => {
    if (!editing) return false;
    const original = report?.updates.find((update) => update.id === editing.id);
    if (!original) return true;
    return (
      editing.status !== original.status
      || editing.markdown !== original.markdown
      || editing.publishedAt !== toDatetimeLocal(original.publishedAt)
    );
  }, [editing, report]);
  const dirty = basicsDirty || affectedDirty || composerDirty || editingDirty;

  // Unsaved-changes protection: the editor lives outside the settings shell,
  // so it registers its own beforeunload guard and shares a dirty flag with
  // the incidents tabs and back link via a module-level store.
  useEffect(() => {
    setReportEditorDirty(dirty);
  }, [dirty]);
  useEffect(() => () => setReportEditorDirty(false), []);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const pickerGroups = useMemo(() => {
    const known = new Set(monitors.map((monitor) => monitor.id));
    const rows = [
      ...monitors,
      ...(report?.affected ?? [])
        .filter((row) => !known.has(row.monitorId))
        .map((row) => ({ id: row.monitorId, name: `${row.monitorName} (archived)`, group: row.groupName })),
    ];
    const groups = new Map<string, ReportEditorMonitor[]>();
    for (const row of rows) {
      const label = row.group ?? "Ungrouped";
      const section = groups.get(label) ?? [];
      section.push(row);
      groups.set(label, section);
    }
    return [...groups.entries()];
  }, [monitors, report]);

  const affectedBody = () =>
    Object.entries(impacts)
      .filter((entry): entry is [string, ReportImpact] => entry[1] !== "none")
      .map(([monitorId, impact]) => ({ monitorId, impact }));

  function changeType(next: ReportType) {
    setType(next);
    setComposerStatus(REPORT_STATUSES[next][0]);
    const allowed = new Set(impactOptions(next).map((option) => option.value));
    setImpacts((current) =>
      Object.fromEntries(Object.entries(current).map(([id, value]) => [id, allowed.has(value) ? value : "none"])),
    );
  }

  async function create() {
    const nextErrors = validateReportForm({
      title,
      startsAt,
      endsAt,
      type,
      requireUpdate: true,
      markdown: composerMarkdown,
      publishedAt: composerPublishedAt,
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setBusy("create");
    setMessage(null);
    try {
      const body = {
        type,
        title: title.trim(),
        startsAt: fromDatetimeLocal(startsAt)!,
        ...(type === "maintenance" && endsAt.trim() ? { endsAt: fromDatetimeLocal(endsAt)! } : {}),
        affected: affectedBody(),
        update: {
          status: composerStatus,
          markdown: composerMarkdown,
          publishedAt: fromDatetimeLocal(composerPublishedAt)!,
        },
        ...(draft ? { draft: true } : {}),
      };
      const result = await apiRequest<ApiEnvelope<{ id: string }>>(
        "/api/v1/status-reports",
        { method: "POST", body: JSON.stringify(body) },
        true,
      );
      router.push(`/incidents/reports/${encodeURIComponent(result.data.id)}`);
    } catch (cause) {
      setMessage({ text: messageForReportError(cause), tone: "error" });
      setBusy(null);
    }
  }

  async function saveBasics() {
    if (!report) return;
    const nextErrors = validateReportForm({
      title,
      startsAt,
      endsAt,
      type,
      requireUpdate: false,
      markdown: "",
      publishedAt: "",
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setBusy("save");
    setMessage(null);
    try {
      const body = {
        title: title.trim(),
        startsAt: fromDatetimeLocal(startsAt)!,
        ...(type === "maintenance" ? { endsAt: endsAt.trim() ? fromDatetimeLocal(endsAt)! : null } : {}),
        // Only send affected when it actually changed: the service treats
        // this key as a full replacement that re-snapshots monitor
        // names/groups from the live registry, so sending it unconditionally
        // would silently rewrite the historical snapshot on every basics-only
        // save (e.g. after a monitor was renamed or moved groups).
        ...(affectedDirty ? { affected: affectedBody() } : {}),
      };
      await apiRequest(
        `/api/v1/status-reports/${encodeURIComponent(report.id)}`,
        { method: "PATCH", body: JSON.stringify(body) },
        true,
      );
      setBaseline({ title, startsAt, endsAt, impacts });
      setMessage({ text: "Report saved", tone: "info" });
      router.refresh();
    } catch (cause) {
      setMessage({ text: messageForReportError(cause), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function postUpdate() {
    if (!report) return;
    const nextErrors = validateReportForm({
      title: report.title,
      startsAt,
      endsAt: "",
      type,
      requireUpdate: true,
      markdown: composerMarkdown,
      publishedAt: composerPublishedAt,
    });
    setErrors({ markdown: nextErrors.markdown, publishedAt: nextErrors.publishedAt });
    if (nextErrors.markdown || nextErrors.publishedAt) return;
    setBusy("post");
    setMessage(null);
    try {
      await apiRequest(
        `/api/v1/status-reports/${encodeURIComponent(report.id)}/updates`,
        {
          method: "POST",
          body: JSON.stringify({
            status: composerStatus,
            markdown: composerMarkdown,
            publishedAt: fromDatetimeLocal(composerPublishedAt)!,
          }),
        },
        true,
      );
      setComposerMarkdown("");
      setComposerPublishedAt(toDatetimeLocal(new Date().toISOString()));
      setMessage({ text: "Update posted", tone: "info" });
      router.refresh();
    } catch (cause) {
      setMessage({ text: messageForReportError(cause), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  function startEditUpdate(updateId: string) {
    const update = report?.updates.find((entry) => entry.id === updateId);
    if (!update) return;
    setConfirmDeleteUpdateId(null);
    setEditing({
      id: update.id,
      status: update.status,
      markdown: update.markdown,
      publishedAt: toDatetimeLocal(update.publishedAt),
      warning: null,
      error: "",
    });
  }

  function setEditingField(patch: Partial<Pick<EditingUpdate, "status" | "markdown" | "publishedAt">>) {
    setEditing((current) => (current ? { ...current, ...patch, warning: null, error: "" } : current));
  }

  async function saveEditedUpdate() {
    if (!report || !editing) return;
    if (!editing.markdown.trim()) {
      setEditing({ ...editing, error: "Update body is required" });
      return;
    }
    // datetime-local drops seconds, so round-tripping an untouched value would
    // silently rewrite publishedAt at minute precision. Only send it (and only
    // apply it to the flip check) when the input actually changed.
    const original = report.updates.find((update) => update.id === editing.id);
    const publishedAtChanged = !original || editing.publishedAt !== toDatetimeLocal(original.publishedAt);
    const publishedAt = publishedAtChanged ? fromDatetimeLocal(editing.publishedAt) : null;
    if (publishedAtChanged && !publishedAt) {
      setEditing({ ...editing, error: "Enter a valid time" });
      return;
    }
    // §3.1 state-change warning: an edited timestamp or status that flips the
    // report between Ongoing and Resolved needs an explicit second confirmation.
    const flip = stateFlipDirection(report.updates, {
      id: editing.id,
      status: editing.status,
      ...(publishedAtChanged && publishedAt ? { publishedAt } : {}),
    });
    if (flip && editing.warning === null) {
      setEditing({ ...editing, warning: flip, error: "" });
      return;
    }
    setBusy(`edit:${editing.id}`);
    setMessage(null);
    try {
      await apiRequest(
        `/api/v1/status-reports/${encodeURIComponent(report.id)}/updates/${encodeURIComponent(editing.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: editing.status,
            markdown: editing.markdown,
            ...(publishedAtChanged && publishedAt ? { publishedAt } : {}),
          }),
        },
        true,
      );
      setEditing(null);
      setMessage({ text: "Update saved", tone: "info" });
      router.refresh();
    } catch (cause) {
      setMessage({ text: messageForReportError(cause), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function deleteUpdate(updateId: string) {
    if (!report) return;
    setBusy(`delete-update:${updateId}`);
    setMessage(null);
    try {
      await apiRequest(
        `/api/v1/status-reports/${encodeURIComponent(report.id)}/updates/${encodeURIComponent(updateId)}`,
        { method: "DELETE" },
        true,
      );
      setConfirmDeleteUpdateId(null);
      setMessage({ text: "Update deleted", tone: "info" });
      router.refresh();
    } catch (cause) {
      setMessage({ text: messageForReportError(cause), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!report) return;
    setBusy("publish");
    setMessage(null);
    try {
      await apiRequest(
        `/api/v1/status-reports/${encodeURIComponent(report.id)}/publish`,
        { method: "POST" },
        true,
      );
      setConfirmPublish(false);
      setMessage({ text: "Report published", tone: "info" });
      router.refresh();
    } catch (cause) {
      setMessage({ text: messageForReportError(cause), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function destroyReport() {
    if (!report) return;
    setBusy("delete");
    setMessage(null);
    try {
      await apiRequest(`/api/v1/status-reports/${encodeURIComponent(report.id)}`, { method: "DELETE" }, true);
      router.push("/incidents/reports");
    } catch (cause) {
      setMessage({ text: messageForReportError(cause), tone: "error" });
      setBusy(null);
    }
  }

  const statuses = REPORT_STATUSES[type];
  const anyBusy = busy !== null;

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">
          {report ? "Edit status report" : "New status report"}
        </h1>
        {report && report.publishedAt === null ? <ReportDraftBadge /> : null}
        {report?.type === "maintenance" ? <ReportTypeChip /> : null}
        {report ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {report.publishedAt === null ? (
              confirmPublish ? (
                <span className="flex items-center gap-2">
                  <span className="max-w-64 text-xs text-[var(--fg-muted)]">
                    Publishing makes this report publicly visible on your status page.
                  </span>
                  <Button size="sm" className="px-2.5" onClick={() => void publish()} disabled={anyBusy}>
                    {busy === "publish" ? "Publishing…" : "Confirm"}
                  </Button>
                  <Button variant="secondary" size="sm" className="px-2.5" onClick={() => setConfirmPublish(false)} disabled={anyBusy}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button size="sm" className="px-2.5" onClick={() => setConfirmPublish(true)} disabled={anyBusy}>
                  Publish
                </Button>
              )
            ) : null}
            {confirmDelete ? (
              <span className="flex items-center gap-2">
                <span className="text-xs text-[var(--fg-muted)]">Delete report?</span>
                <Button variant="error" size="sm" className="px-2.5" onClick={() => void destroyReport()} disabled={anyBusy}>
                  {busy === "delete" ? "Deleting…" : "Confirm"}
                </Button>
                <Button variant="secondary" size="sm" className="px-2.5" onClick={() => setConfirmDelete(false)} disabled={anyBusy}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button variant="error-outline" size="sm" className="px-2.5" onClick={() => setConfirmDelete(true)} disabled={anyBusy}>
                Delete
              </Button>
            )}
          </div>
        ) : null}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Basic Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Title" htmlFor="report-title" error={errors.title}>
                <Input
                  id="report-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  aria-invalid={Boolean(errors.title)}
                  placeholder={type === "maintenance" ? "Scheduled database maintenance" : "Elevated API error rates"}
                />
              </Field>
              <div className="grid gap-2">
                <label id="report-type-label" className="text-sm leading-5 font-medium text-[var(--fg)]">Type</label>
                <Select value={type} onValueChange={(value) => changeType(value as ReportType)} disabled={Boolean(report)}>
                  <SelectTrigger aria-labelledby="report-type-label"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="incident">Incident</SelectItem>
                    <SelectItem value="maintenance">Maintenance</SelectItem>
                  </SelectContent>
                </Select>
                {report ? (
                  <p className="text-xs leading-4 text-[var(--fg-muted)]">Type is locked after creation</p>
                ) : null}
              </div>
              <Field label="Starts at" htmlFor="report-starts" error={errors.startsAt}>
                <Input
                  id="report-starts"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(event) => setStartsAt(event.target.value)}
                  aria-invalid={Boolean(errors.startsAt)}
                />
              </Field>
              {type === "maintenance" ? (
                <Field
                  label="Ends at"
                  htmlFor="report-ends"
                  description="End of the maintenance window — leave empty if open-ended"
                  error={errors.endsAt}
                >
                  <Input
                    id="report-ends"
                    type="datetime-local"
                    value={endsAt}
                    onChange={(event) => setEndsAt(event.target.value)}
                    aria-invalid={Boolean(errors.endsAt)}
                  />
                </Field>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Update Timeline</CardTitle>
              <CardDescription>
                {report ? "Newest first — updates render on your status page" : "The first update publishes with the report"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <label id="composer-status-label" className="text-sm leading-5 font-medium text-[var(--fg)]">Status</label>
                    <Select value={composerStatus} onValueChange={(value) => setComposerStatus(value as ReportUpdateStatus)}>
                      <SelectTrigger aria-labelledby="composer-status-label"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {statuses.map((status) => (
                          <SelectItem key={status} value={status}>{REPORT_STATUS_LABELS[status]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Field label="Published at" htmlFor="composer-published" error={errors.publishedAt}>
                    <Input
                      id="composer-published"
                      type="datetime-local"
                      value={composerPublishedAt}
                      onChange={(event) => setComposerPublishedAt(event.target.value)}
                      aria-invalid={Boolean(errors.publishedAt)}
                    />
                  </Field>
                </div>
                {isBeforeStart(composerPublishedAt, startsAt) ? (
                  <p role="status" className="text-[13px] text-[var(--down-text)]">{BEFORE_START_COPY}</p>
                ) : null}
                <Field
                  label={report ? "New update" : "Initial update"}
                  htmlFor="composer-markdown"
                  description="You can use markdown."
                  error={errors.markdown}
                >
                  <textarea
                    id="composer-markdown"
                    rows={4}
                    value={composerMarkdown}
                    onChange={(event) => setComposerMarkdown(event.target.value)}
                    aria-invalid={Boolean(errors.markdown)}
                    className={textareaClass}
                  />
                </Field>
                {report ? (
                  <div className="flex justify-end">
                    <Button size="sm" className="px-2.5" onClick={() => void postUpdate()} disabled={anyBusy}>
                      {busy === "post" ? "Posting…" : "Post Update"}
                    </Button>
                  </div>
                ) : null}
              </div>

              {report ? (
                <ul className="space-y-4 border-t border-[var(--border)] pt-5">
                  {report.updates.map((update) => {
                    // §3.1: deleting the latest resolving update can flip the
                    // report back to Ongoing — warn inside the delete confirm.
                    const deleteFlip =
                      confirmDeleteUpdateId === update.id ? stateFlipAfterRemoval(report.updates, update.id) : null;
                    return (
                    <li key={update.id} className="rounded-[8px] border border-[var(--border)] p-4">
                      {editing?.id === update.id ? (
                        <div className="space-y-3">
                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="grid gap-2">
                              <label id={`edit-status-label-${update.id}`} className="text-[13px] font-medium">Status</label>
                              <Select value={editing.status} onValueChange={(value) => setEditingField({ status: value as ReportUpdateStatus })}>
                                <SelectTrigger aria-labelledby={`edit-status-label-${update.id}`}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {statuses.map((status) => (
                                    <SelectItem key={status} value={status}>{REPORT_STATUS_LABELS[status]}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <Field label="Published at" htmlFor={`edit-published-${update.id}`}>
                              <Input
                                id={`edit-published-${update.id}`}
                                type="datetime-local"
                                value={editing.publishedAt}
                                onChange={(event) => setEditingField({ publishedAt: event.target.value })}
                              />
                            </Field>
                          </div>
                          {isBeforeStart(editing.publishedAt, startsAt) ? (
                            <p role="status" className="text-[13px] text-[var(--down-text)]">{BEFORE_START_COPY}</p>
                          ) : null}
                          <Field label="Update" htmlFor={`edit-markdown-${update.id}`} description="You can use markdown." error={editing.error || undefined}>
                            <textarea
                              id={`edit-markdown-${update.id}`}
                              rows={4}
                              value={editing.markdown}
                              onChange={(event) => setEditingField({ markdown: event.target.value })}
                              aria-invalid={Boolean(editing.error)}
                              className={textareaClass}
                            />
                          </Field>
                          {editing.warning ? (
                            <p role="status" className="text-[13px] text-[var(--down-text)]">
                              {STATE_FLIP_COPY[editing.warning]}
                            </p>
                          ) : null}
                          <div className="flex justify-end gap-2">
                            <Button variant="secondary" size="sm" className="px-2.5" onClick={() => setEditing(null)} disabled={anyBusy}>
                              Cancel
                            </Button>
                            <Button size="sm" className="px-2.5" onClick={() => void saveEditedUpdate()} disabled={anyBusy}>
                              {busy === `edit:${update.id}` ? "Saving…" : editing.warning ? "Save Anyway" : "Save Update"}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            <ReportStatusChip status={update.status} />
                            <span className="font-data text-xs text-[var(--fg-muted)]">
                              <IncidentTime value={update.publishedAt} />
                            </span>
                            <span className="ml-auto flex items-center gap-1">
                              {confirmDeleteUpdateId === update.id ? (
                                <>
                                  {deleteFlip ? (
                                    <span role="status" className="max-w-72 text-xs text-[var(--down-text)]">
                                      {STATE_FLIP_COPY[deleteFlip]}
                                    </span>
                                  ) : null}
                                  <span className="text-xs text-[var(--fg-muted)]">Delete update?</span>
                                  <Button variant="error" size="sm" className="px-2.5" onClick={() => void deleteUpdate(update.id)} disabled={anyBusy}>
                                    {busy === `delete-update:${update.id}` ? "Deleting…" : "Confirm"}
                                  </Button>
                                  <Button variant="secondary" size="sm" className="px-2.5" onClick={() => setConfirmDeleteUpdateId(null)} disabled={anyBusy}>
                                    Cancel
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <Button variant="tertiary" size="sm" className="px-2" onClick={() => startEditUpdate(update.id)} disabled={anyBusy}>
                                    Edit
                                  </Button>
                                  <Button
                                    variant="tertiary"
                                    size="sm"
                                    className="px-2 text-[var(--down-text)]"
                                    onClick={() => setConfirmDeleteUpdateId(update.id)}
                                    disabled={anyBusy}
                                  >
                                    Delete
                                  </Button>
                                </>
                              )}
                            </span>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap font-data text-[13px]">{update.markdown}</p>
                        </>
                      )}
                    </li>
                    );
                  })}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Affected Services</CardTitle>
            <CardDescription>Impact shown per service on the status page</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {pickerGroups.length === 0 ? (
              <p className="text-[13px] text-[var(--fg-muted)]">No monitors configured.</p>
            ) : (
              pickerGroups.map(([groupName, rows]) => (
                <section key={groupName} aria-label={groupName}>
                  <h3 className="mb-2 text-xs font-medium text-[var(--fg-muted)]">{groupName}</h3>
                  <ul className="space-y-2">
                    {rows.map((row) => (
                      <li key={row.id} className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate text-[13px]" title={row.name}>{row.name}</span>
                        <Select
                          value={impacts[row.id] ?? "none"}
                          onValueChange={(value) => setImpacts((current) => ({ ...current, [row.id]: value as ImpactValue }))}
                        >
                          <SelectTrigger className="h-8 w-36 shrink-0 text-xs" aria-label={`Impact for ${row.name}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {impactOptions(type).map((option) => (
                              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p aria-live="polite" className={`text-[13px] ${message?.tone === "error" ? "text-[var(--down-text)]" : "text-[var(--fg-muted)]"}`}>
          {message?.text ?? ""}
        </p>
        <div className="flex items-center gap-4">
          {report ? (
            <Button onClick={() => void saveBasics()} disabled={anyBusy || !(basicsDirty || affectedDirty)}>
              {busy === "save" ? "Saving…" : "Save Changes"}
            </Button>
          ) : (
            <>
              <label className="flex items-center gap-2 text-[13px] font-medium">
                <input
                  type="checkbox"
                  checked={draft}
                  onChange={(event) => setDraft(event.target.checked)}
                  className="size-4 accent-[var(--fg)]"
                />
                Save as draft
              </label>
              <Button onClick={() => void create()} disabled={anyBusy}>
                {busy === "create" ? "Creating…" : "Create Status Report"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
