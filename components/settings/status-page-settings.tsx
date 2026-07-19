"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useDirtyGuard } from "@/components/settings/settings-dirty";
import { CardHeading } from "@/components/settings/settings-row";
import { StatusMessage, type Message } from "@/components/settings/status-message";
import { timezoneOptions } from "@/components/settings/timezone-control";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { statusAssetUrl } from "@/lib/status-page/display";
import { MAX_NAV_LINKS, type StatusPageConfigDocument } from "@/lib/status-page/schema";
import { cn } from "@/lib/utils";

export type StatusPageSettingsData = {
  config: StatusPageConfigDocument;
  etag: string;
};

export const STATUS_PAGE_FIELDS = [
  "name",
  "layout",
  "theme",
  "logoLightImageId",
  "logoDarkImageId",
  "faviconImageId",
  "homepageUrl",
  "contactUrl",
  "navLinks",
  "googleTagId",
  "customCss",
  "customHead",
  "announcementEnabled",
  "announcementMarkdown",
  "historyDays",
  "uptimeDecimals",
  "unknownAsOperational",
  "minIncidentSeconds",
  "timezone",
] as const satisfies readonly (keyof StatusPageConfigDocument)[];

function fieldEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function documentsEqual(left: StatusPageConfigDocument, right: StatusPageConfigDocument): boolean {
  return STATUS_PAGE_FIELDS.every((field) => fieldEqual(left[field], right[field]));
}

/** The exact PUT payload: every document field, nothing else. */
export function toDocument(draft: StatusPageConfigDocument): StatusPageConfigDocument {
  const document = {} as Record<keyof StatusPageConfigDocument, unknown>;
  for (const field of STATUS_PAGE_FIELDS) document[field] = draft[field];
  return document as StatusPageConfigDocument;
}

/**
 * Three-way merge for 412 recovery: fields the local draft changed
 * relative to its base win over the refreshed server document. Everything else
 * takes the server value. Local edits are never dropped.
 */
export function mergeStatusPageDrafts(
  base: StatusPageConfigDocument,
  local: StatusPageConfigDocument,
  server: StatusPageConfigDocument,
): StatusPageConfigDocument {
  const merged = structuredClone(toDocument(server)) as Record<keyof StatusPageConfigDocument, unknown>;
  for (const field of STATUS_PAGE_FIELDS) {
    if (!fieldEqual(local[field], base[field])) {
      merged[field] = structuredClone(local[field]);
    }
  }
  return merged as StatusPageConfigDocument;
}

type ApiErrorEnvelope = { error?: { message?: string } };

async function errorMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as ApiErrorEnvelope;
  return payload.error?.message || `Request failed (${response.status})`;
}

const HISTORY_DAY_OPTIONS = [30, 60, 90] as const;
const DECIMAL_OPTIONS = [
  { value: 0, label: "0 decimals (99%)" },
  { value: 1, label: "1 decimal (99.9%)" },
  { value: 2, label: "2 decimals (99.99%)" },
  { value: 3, label: "3 decimals (99.987%)" },
];
const MIN_INCIDENT_OPTIONS = [
  { value: 0, label: "Show everything" },
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 120, label: "2 minutes" },
  { value: 300, label: "5 minutes" },
  { value: 600, label: "10 minutes" },
  { value: 1800, label: "30 minutes" },
];

/** CLI-set values outside the presets still render and round-trip intact. */
function minIncidentOptionsIncluding(value: number) {
  return MIN_INCIDENT_OPTIONS.some((option) => option.value === value)
    ? MIN_INCIDENT_OPTIONS
    : [...MIN_INCIDENT_OPTIONS, { value, label: `${value} seconds` }].sort((left, right) => left.value - right.value);
}

const publicTimezoneOptions = [
  { label: "UTC", value: "UTC" },
  ...timezoneOptions.filter((zone) => zone.value !== "system" && zone.value !== "UTC"),
];

function timezoneOptionsIncluding(value: string) {
  return publicTimezoneOptions.some((zone) => zone.value === value)
    ? publicTimezoneOptions
    : [...publicTimezoneOptions, { label: value, value }];
}

const layoutOptions: { value: StatusPageConfigDocument["layout"]; label: string; description: string }[] = [
  { value: "vertical", label: "Vertical", description: "Logo above the page title" },
  { value: "horizontal", label: "Horizontal", description: "Logo, title, and links in one row" },
];

function LayoutThumbnail({ variant }: { variant: StatusPageConfigDocument["layout"] }) {
  return (
    <svg viewBox="0 0 88 56" width="88" height="56" aria-hidden focusable="false" className="block">
      <rect width="88" height="56" fill="var(--bg)" />
      {variant === "vertical" ? (
        <>
          <rect x="6" y="6" width="14" height="6" rx="2" fill="var(--fg-faint)" />
          <rect x="6" y="16" width="30" height="3" rx="1.5" fill="var(--fg-muted)" />
          <rect x="6" y="24" width="76" height="12" rx="3" fill="var(--chip-bg)" />
          <rect x="6" y="40" width="76" height="12" rx="3" fill="var(--chip-bg)" />
        </>
      ) : (
        <>
          <rect x="6" y="7" width="14" height="6" rx="2" fill="var(--fg-faint)" />
          <rect x="24" y="8.5" width="24" height="3" rx="1.5" fill="var(--fg-muted)" />
          <rect x="58" y="8.5" width="10" height="3" rx="1.5" fill="var(--fg-faint)" />
          <rect x="72" y="8.5" width="10" height="3" rx="1.5" fill="var(--fg-faint)" />
          <rect x="6" y="20" width="76" height="14" rx="3" fill="var(--chip-bg)" />
          <rect x="6" y="38" width="76" height="14" rx="3" fill="var(--chip-bg)" />
        </>
      )}
    </svg>
  );
}

function LayoutPicker({
  value,
  onChange,
}: {
  value: StatusPageConfigDocument["layout"];
  onChange: (value: StatusPageConfigDocument["layout"]) => void;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1
      : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + layoutOptions.length) % layoutOptions.length;
    onChange(layoutOptions[next]!.value);
    buttons.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label="Header layout" className="flex flex-wrap gap-3">
      {layoutOptions.map((option, index) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            ref={(element) => { buttons.current[index] = element; }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className="group flex flex-col items-start gap-1.5 rounded-[8px]"
          >
            <span
              className={cn(
                "overflow-hidden rounded-[6px] border transition-shadow duration-150",
                selected
                  ? "border-[var(--focus)] shadow-[0_0_0_2px_var(--focus)]"
                  : "border-[var(--border-strong)] group-hover:border-[var(--border-hover)]",
              )}
            >
              <LayoutThumbnail variant={option.value} />
            </span>
            <span className={cn("px-0.5 text-[12px]", selected ? "font-medium text-[var(--fg)]" : "text-[var(--fg-muted)]")}>
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Client mirror of the server caps in lib/api/images.ts
// (MAX_IMAGE_BYTES / MAX_FAVICON_BYTES) so bad files fail before the upload.
const MAX_UPLOAD_BYTES = 512 * 1024;
const MAX_FAVICON_UPLOAD_BYTES = 32 * 1024;
const LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];
const FAVICON_MIME_TYPES = ["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml"];

export function uploadValidationError(kind: "logo-light" | "logo-dark" | "favicon", file: File): string {
  const favicon = kind === "favicon";
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(favicon ? FAVICON_MIME_TYPES : LOGO_MIME_TYPES).includes(type)) {
    return favicon ? "Use a PNG, ICO, or SVG file." : "Use a PNG, JPEG, SVG, or WebP image.";
  }
  if (file.size > (favicon ? MAX_FAVICON_UPLOAD_BYTES : MAX_UPLOAD_BYTES)) {
    return favicon ? "Favicon files must be at most 32 KB." : "Images must be at most 512 KB.";
  }
  return "";
}

function ImageUploadZone({
  label,
  kind,
  imageId,
  savedImageId,
  onChange,
  hint,
}: {
  label: string;
  kind: "logo-light" | "logo-dark" | "favicon";
  imageId: string | null;
  /** The id in the last-saved document, used to distinguish persisted from pending. */
  savedImageId: string | null;
  onChange: (imageId: string | null) => void;
  hint: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Image ids rotate on every upload, so a draft id differing from the saved
  // one always means "uploaded this session, pending the page-level save".
  const freshUpload = imageId !== null && imageId !== savedImageId;

  async function upload(file: File) {
    const preflightError = uploadValidationError(kind, file);
    if (preflightError) {
      setError(preflightError);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", kind);
      const response = await fetch("/api/v1/images", { method: "POST", body: form });
      if (!response.ok) throw new Error(await errorMessage(response));
      const payload = (await response.json()) as { data?: { id?: string } };
      if (!payload.data?.id) throw new Error("Upload failed. Try again.");
      if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        setLocalPreview(URL.createObjectURL(file));
      }
      onChange(payload.data.id);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed. Try again.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  // Fresh uploads preview from the picked file. Persisted logos use the public
  // asset route and persisted favicons the authenticated image route.
  const previewUrl = freshUpload
    ? localPreview
    : imageId
      ? kind === "favicon"
        ? `/api/v1/images/${imageId}`
        : statusAssetUrl(imageId)
      : null;
  const noun = kind === "favicon" ? "favicon" : "logo";
  const statusText = busy
    ? "Uploading…"
    : imageId
      ? freshUpload
        ? "Ready — save to apply"
        : `Current ${noun} — saved`
      : hint;

  return (
    <div>
      <p className="mb-2 text-[13px] font-medium">{label}</p>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragEnter={() => setDragOver(true)}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          const file = event.dataTransfer.files?.[0];
          if (file && !busy) void upload(file);
        }}
        className={cn(
          "flex min-h-[84px] items-center justify-between gap-3 rounded-[8px] border border-dashed px-4 py-3 transition-colors duration-100",
          dragOver ? "border-[var(--focus)] bg-[var(--hover)]" : "border-[var(--border-strong)]",
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- uploaded bytes, not an optimizable static asset
            <img src={previewUrl} alt="" aria-hidden className="max-h-10 max-w-[96px] rounded-[4px] object-contain" />
          ) : null}
          <p className="text-[13px] text-[var(--fg-muted)]">{statusText}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
            Browse
          </Button>
          {imageId ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setLocalPreview(null);
                onChange(null);
              }}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={kind === "favicon" ? "image/png,image/x-icon,image/svg+xml" : "image/png,image/jpeg,image/svg+xml,image/webp"}
        className="sr-only"
        aria-label={label}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      {error ? <p role="alert" className="mt-1 text-xs text-[var(--down-text)]">{error}</p> : null}
    </div>
  );
}

function CheckboxRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 accent-[var(--fg)]"
      />
      <label htmlFor={id} className="min-w-0">
        <span className="block text-[13px] font-medium">{label}</span>
        {description ? <span className="mt-0.5 block text-[13px] text-[var(--fg-muted)]">{description}</span> : null}
      </label>
    </div>
  );
}

const textareaClass =
  "w-full resize-y rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 text-[13px] leading-5";

export function StatusPageSettings({ data }: { data: StatusPageSettingsData }) {
  const router = useRouter();
  const [saved, setSaved] = useState<StatusPageConfigDocument>(() => toDocument(data.config));
  const [draft, setDraft] = useState<StatusPageConfigDocument>(() => structuredClone(toDocument(data.config)));
  const [etag, setEtag] = useState(data.etag);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // Link-row validation only surfaces on a save attempt, so a
  // just-added empty row never fires an instant alert.
  const [navLinksError, setNavLinksError] = useState("");
  const statusRef = useRef<HTMLParagraphElement>(null);

  const dirty = !documentsEqual(draft, saved);
  useDirtyGuard("status-page", dirty);

  const draftRef = useRef(draft);
  const savedRef = useRef(saved);
  const etagRef = useRef(etag);
  useEffect(() => {
    draftRef.current = draft;
    savedRef.current = saved;
    etagRef.current = etag;
  });

  // A remount can hydrate from a cached snapshot (client router cache,
  // prefetched payload, bfcache) whose etag is stale. Saving with that etag
  // 412s against the user's own previous save and surfaces as a phantom
  // "changed elsewhere" conflict. Revalidate once on mount and adopt the
  // server document only while the form is pristine. A form the user has
  // already edited is left alone, the existing 412 recovery covers it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/v1/status-page-config", { cache: "no-store" });
        if (!response.ok) return;
        const nextEtag = response.headers.get("ETag");
        const payload = (await response.json()) as { data: StatusPageConfigDocument };
        if (cancelled || !nextEtag || nextEtag === etagRef.current) return;
        if (!documentsEqual(draftRef.current, savedRef.current)) return;
        const server = toDocument(payload.data);
        setEtag(nextEtag);
        setSaved(server);
        setDraft(structuredClone(server));
      } catch {
        // Revalidation is best-effort. A stale etag still recovers through
        // the conflict path on save.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function update(patch: Partial<StatusPageConfigDocument>) {
    if (patch.navLinks) setNavLinksError("");
    setDraft((current) => ({ ...current, ...patch }));
  }

  function textOrNull(value: string): string | null {
    return value === "" ? null : value;
  }

  const nameError = draft.name.trim() ? "" : "Page name is required";

  async function save() {
    if (busy || nameError) return;
    // Fully-empty rows are dropped. Partially-filled rows block the save.
    const navLinks = draft.navLinks.filter((link) => link.label.trim() || link.url.trim());
    if (navLinks.some((link) => !link.label.trim() || !link.url.trim())) {
      setNavLinksError("Every link needs a label and a URL");
      return;
    }
    setNavLinksError("");
    setBusy(true);
    setMessage(null);
    const document = toDocument({ ...draft, navLinks });
    try {
      const response = await fetch("/api/v1/status-page-config", {
        method: "PUT",
        // The config PUT route requires a UUID Idempotency-Key (executeIdempotent).
        // Without it every save fails with IDEMPOTENCY_KEY_REQUIRED.
        headers: { "Content-Type": "application/json", "If-Match": etag, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(document),
      });
      if (response.status === 412) {
        await recoverFromConflict();
        return;
      }
      if (!response.ok) throw new Error(await errorMessage(response));
      const nextEtag = response.headers.get("ETag");
      setSaved(document);
      setDraft(structuredClone(document));
      if (nextEtag) setEtag(nextEtag);
      setMessage({ text: "Status page settings saved", tone: "info" });
      // The sticky bar (and the focused Save button) unmounts on success.
      // Hand focus to the always-mounted status region instead of <body>.
      statusRef.current?.focus();
      router.refresh();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Request failed. Try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function recoverFromConflict() {
    try {
      const response = await fetch("/api/v1/status-page-config");
      if (!response.ok) throw new Error(await errorMessage(response));
      const payload = (await response.json()) as { data: StatusPageConfigDocument };
      const server = toDocument(payload.data);
      const nextEtag = response.headers.get("ETag");
      setDraft(mergeStatusPageDrafts(saved, draft, server));
      setSaved(server);
      if (nextEtag) setEtag(nextEtag);
      setMessage({ text: "Settings changed elsewhere — your edits are preserved, review and save again", tone: "error" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Request failed. Try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setDraft(structuredClone(saved));
    setNavLinksError("");
    setMessage({ text: "Changes discarded", tone: "info" });
    // The sticky bar unmounts. Keep focus on something real.
    statusRef.current?.focus();
  }


  const announcementPreview = draft.announcementEnabled ? (draft.announcementMarkdown ?? "").trim() : "";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeading title="Personalization" />
        <CardContent className="pt-0">
          <div className="max-w-[640px] space-y-5">
            <Field label="Page name" htmlFor="sp-name" error={nameError || undefined}>
              <Input
                id="sp-name"
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                maxLength={80}
                inputSize="sm"
                className="max-w-[320px]"
                aria-invalid={Boolean(nameError) || undefined}
              />
            </Field>
            <div>
              <p className="mb-2 text-[13px] font-medium">Header layout</p>
              <LayoutPicker value={draft.layout} onChange={(layout) => update({ layout })} />
            </div>
            <div>
              <p className="mb-2 text-[13px] font-medium">Theme</p>
              <Select
                value={draft.theme}
                onValueChange={(theme) => update({ theme: theme as StatusPageConfigDocument["theme"] })}
              >
                <SelectTrigger className="w-[220px]" aria-label="Page theme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">Follow the visitor&rsquo;s device</SelectItem>
                  <SelectItem value="light">Always light</SelectItem>
                  <SelectItem value="dark">Always dark</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ImageUploadZone
              label="Logo (light theme)"
              kind="logo-light"
              imageId={draft.logoLightImageId}
              savedImageId={saved.logoLightImageId}
              onChange={(logoLightImageId) => update({ logoLightImageId })}
              hint="Drop an image or browse — PNG, JPEG, SVG, or WebP up to 512 KB"
            />
            <ImageUploadZone
              label="Logo (dark theme)"
              kind="logo-dark"
              imageId={draft.logoDarkImageId}
              savedImageId={saved.logoDarkImageId}
              onChange={(logoDarkImageId) => update({ logoDarkImageId })}
              hint="Drop an image or browse — PNG, JPEG, SVG, or WebP up to 512 KB"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeading title="Links & URLs" />
        <CardContent className="pt-0">
          <div className="max-w-[640px] space-y-4">
            <Field
              label="Homepage URL"
              htmlFor="sp-homepage"
              description="The logo links here when set."
            >
              <Input
                id="sp-homepage"
                type="url"
                value={draft.homepageUrl ?? ""}
                onChange={(event) => update({ homepageUrl: textOrNull(event.target.value) })}
                placeholder="https://example.com"
                inputSize="sm"
                className="max-w-[420px] font-data"
              />
            </Field>
            <Field
              label="Contact URL"
              htmlFor="sp-contact"
              description={'Shows a "Get in touch" button. Web addresses and mailto: links work.'}
            >
              <Input
                id="sp-contact"
                value={draft.contactUrl ?? ""}
                onChange={(event) => update({ contactUrl: textOrNull(event.target.value) })}
                placeholder="mailto:support@example.com"
                inputSize="sm"
                className="max-w-[420px] font-data"
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeading title="Announcement" />
        <CardContent className="pt-0">
          <div className="max-w-[640px] space-y-4">
            <CheckboxRow
              id="sp-announcement-enabled"
              label="Show announcement"
              description="Displayed above the status banner on the public page."
              checked={draft.announcementEnabled}
              onChange={(announcementEnabled) => update({ announcementEnabled })}
            />
            <label className="block">
              <span className="mb-2 block text-[13px] font-medium">Announcement</span>
              <textarea
                value={draft.announcementMarkdown ?? ""}
                onChange={(event) => update({ announcementMarkdown: textOrNull(event.target.value) })}
                rows={4}
                placeholder="Scheduled maintenance this Saturday…"
                aria-label="Announcement markdown"
                className={textareaClass}
              />
              <span className="mt-1 block text-xs text-[var(--fg-muted)]">
                Supports [links](https://…), **bold**, *italic*, and `code`. Up to 2 KB.
              </span>
            </label>
            {announcementPreview ? (
              <div aria-label="Announcement preview" className="rounded-[8px] border border-[var(--border)] bg-[var(--chip-bg)] p-4">
                <div className="space-y-2 text-[13px] leading-[19px]">
                  {announcementPreview.split(/\n[\t ]*\n+/).map((paragraph, index) => (
                    <p key={index} className="whitespace-pre-wrap">{paragraph.trim()}</p>
                  ))}
                </div>
                <p className="mt-3 border-t border-[var(--border)] pt-2 text-xs text-[var(--fg-faint)]">
                  Plain-text preview — markdown formatting is applied on the published page.
                </p>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeading title="Look & Feel" />
        <CardContent className="pt-0">
          <div className="max-w-[640px] space-y-5">
            <ImageUploadZone
              label="Favicon"
              kind="favicon"
              imageId={draft.faviconImageId}
              savedImageId={saved.faviconImageId}
              onChange={(faviconImageId) => update({ faviconImageId })}
              hint="Drop an image or browse — PNG, ICO, or SVG up to 32 KB"
            />
            <div>
              <p className="mb-2 text-[13px] font-medium">Display time zone</p>
              <Select
                value={draft.timezone ?? "UTC"}
                onValueChange={(timezone) => update({ timezone: timezone === "UTC" ? null : timezone })}
              >
                <SelectTrigger className="w-[280px]" aria-label="Display time zone">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {timezoneOptionsIncluding(draft.timezone ?? "UTC").map((zone) => (
                    <SelectItem key={zone.value} value={zone.value}>
                      {zone.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-[var(--fg-faint)]">Public page timestamps display in this zone, labeled with its offset.</p>
            </div>
            <label className="block">
              <span className="mb-2 block text-[13px] font-medium">Custom CSS</span>
              <textarea
                value={draft.customCss ?? ""}
                onChange={(event) => update({ customCss: textOrNull(event.target.value) })}
                rows={6}
                spellCheck={false}
                aria-label="Custom CSS"
                className={cn(textareaClass, "font-data")}
              />
              <span className="mt-1 block text-xs text-[var(--fg-muted)]">Injected into the public page as a style tag. Up to 10 KB.</span>
            </label>
            <label className="block">
              <span className="mb-2 block text-[13px] font-medium">Custom HTML</span>
              <textarea
                value={draft.customHead ?? ""}
                onChange={(event) => update({ customHead: textOrNull(event.target.value) })}
                rows={6}
                spellCheck={false}
                aria-label="Custom HTML"
                className={cn(textareaClass, "font-data")}
              />
              <span className="mt-1 block text-xs text-[var(--fg-muted)]">
                Raw markup injected at the top of the public page&rsquo;s body, not the document
                &lt;head&gt; — tools that only read the head, like meta-tag site verifiers, will not
                see it. Scripts and styles run as written. Up to 10 KB.
              </span>
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeading title="Status History" />
        <CardContent className="pt-0">
          <div className="max-w-[640px] space-y-5">
            <div>
              <p className="mb-2 text-[13px] font-medium">History window</p>
              <Select
                value={String(draft.historyDays)}
                onValueChange={(value) => update({ historyDays: Number(value) as StatusPageConfigDocument["historyDays"] })}
              >
                <SelectTrigger className="w-[220px]" aria-label="History window">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HISTORY_DAY_OPTIONS.map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {days} days
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-[var(--fg-faint)]">Timelines and uptime figures cover this window.</p>
            </div>
            <div>
              <p className="mb-2 text-[13px] font-medium">Uptime precision</p>
              <Select
                value={String(draft.uptimeDecimals)}
                onValueChange={(value) => update({ uptimeDecimals: Number(value) })}
              >
                <SelectTrigger className="w-[220px]" aria-label="Uptime precision">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DECIMAL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <p className="mb-2 text-[13px] font-medium">Hide resolved blips shorter than</p>
              <Select
                value={String(draft.minIncidentSeconds)}
                onValueChange={(value) => update({ minIncidentSeconds: Number(value) })}
              >
                <SelectTrigger className="w-[220px]" aria-label="Hide resolved blips shorter than">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {minIncidentOptionsIncluding(draft.minIncidentSeconds).map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-[var(--fg-faint)]">
                Hides short resolved incidents from incident history. Timelines always reflect raw availability.
              </p>
            </div>
            <CheckboxRow
              id="sp-unknown-operational"
              label="Show unknown periods as operational"
              description="Timeline stretches without data render as operational instead of gray."
              checked={draft.unknownAsOperational}
              onChange={(unknownAsOperational) => update({ unknownAsOperational })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeading title="Analytics & Navigation" />
        <CardContent className="pt-0">
          <div className="max-w-[640px] space-y-5">
            <Field
              label="Google tag ID"
              htmlFor="sp-google-tag"
              description="G-XXXXXXX or GT-XXXXXXX. The tag script is emitted on the public page only."
            >
              <Input
                id="sp-google-tag"
                value={draft.googleTagId ?? ""}
                onChange={(event) => update({ googleTagId: textOrNull(event.target.value.toUpperCase().trim()) })}
                placeholder="G-XXXXXXXXXX"
                inputSize="sm"
                className="max-w-[240px] font-data"
              />
            </Field>
            <div>
              <p className="text-[13px] font-medium">Navigation links</p>
              <p className="mt-0.5 text-[13px] text-[var(--fg-muted)]">Shown in the public page header. Up to {MAX_NAV_LINKS} links.</p>
              {draft.navLinks.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {draft.navLinks.map((link, index) => (
                    <div key={index} className="flex flex-wrap items-center gap-2">
                      <Input
                        value={link.label}
                        onChange={(event) => {
                          const navLinks = draft.navLinks.map((entry, at) =>
                            at === index ? { ...entry, label: event.target.value } : entry);
                          update({ navLinks });
                        }}
                        maxLength={40}
                        placeholder="Label"
                        inputSize="sm"
                        className="w-[160px]"
                        aria-label={`Link ${index + 1} label`}
                      />
                      <Input
                        value={link.url}
                        onChange={(event) => {
                          const navLinks = draft.navLinks.map((entry, at) =>
                            at === index ? { ...entry, url: event.target.value } : entry);
                          update({ navLinks });
                        }}
                        placeholder="https://example.com"
                        inputSize="sm"
                        className="min-w-[220px] flex-1 font-data"
                        aria-label={`Link ${index + 1} URL`}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        aria-label={`Remove link ${index + 1}`}
                        onClick={() => update({ navLinks: draft.navLinks.filter((_, at) => at !== index) })}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
              {navLinksError ? <p role="alert" className="mt-2 text-xs text-[var(--down-text)]">{navLinksError}</p> : null}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-3"
                disabled={draft.navLinks.length >= MAX_NAV_LINKS}
                onClick={() => update({ navLinks: [...draft.navLinks, { label: "", url: "" }] })}
              >
                Add Link
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <StatusMessage ref={statusRef} message={message} />

      {/* Always-mounted announcer: says "Unsaved changes" once when the bar
          first appears, then stays silent until the next clean→dirty edge. */}
      <p aria-live="polite" className="sr-only">
        {dirty ? "Unsaved changes" : ""}
      </p>

      {dirty ? (
        <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg)] px-4 py-3 shadow-[var(--card-shadow)]">
          <p className="text-[13px] font-medium">Unsaved changes</p>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={discard} disabled={busy}>
              Discard
            </Button>
            <Button type="button" size="sm" onClick={() => void save()} disabled={busy || Boolean(nameError)}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
