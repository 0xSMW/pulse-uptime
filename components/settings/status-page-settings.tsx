"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"

import { useDirtyGuard } from "@/components/settings/settings-dirty"
import { CardHeading } from "@/components/settings/settings-row"
import {
  type Message,
  StatusMessage,
} from "@/components/settings/status-message"
import { timezoneOptions } from "@/components/settings/timezone-control"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { statusAssetUrl } from "@/lib/status-page/display"
import {
  MAX_NAV_LINKS,
  type StatusPageConfigDocument,
} from "@/lib/status-page/schema"
import { cn } from "@/lib/utils"

export interface StatusPageSettingsData {
  config: StatusPageConfigDocument
  etag: string
}

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
] as const satisfies readonly (keyof StatusPageConfigDocument)[]

function fieldEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

export function documentsEqual(
  left: StatusPageConfigDocument,
  right: StatusPageConfigDocument
): boolean {
  return STATUS_PAGE_FIELDS.every((field) =>
    fieldEqual(left[field], right[field])
  )
}

/** The exact PUT payload: every document field, nothing else. */
export function toDocument(
  draft: StatusPageConfigDocument
): StatusPageConfigDocument {
  const document = {} as Record<keyof StatusPageConfigDocument, unknown>
  for (const field of STATUS_PAGE_FIELDS) {
    document[field] = draft[field]
  }
  return document as StatusPageConfigDocument
}

/**
 * Three-way merge for 412 recovery: fields the local draft changed
 * relative to its base win over the refreshed server document. Everything else
 * takes the server value. Local edits are never dropped.
 */
export function mergeStatusPageDrafts(
  base: StatusPageConfigDocument,
  local: StatusPageConfigDocument,
  server: StatusPageConfigDocument
): StatusPageConfigDocument {
  const merged = structuredClone(toDocument(server)) as Record<
    keyof StatusPageConfigDocument,
    unknown
  >
  for (const field of STATUS_PAGE_FIELDS) {
    if (!fieldEqual(local[field], base[field])) {
      merged[field] = structuredClone(local[field])
    }
  }
  return merged as StatusPageConfigDocument
}

interface ApiErrorEnvelope {
  error?: { message?: string }
}

async function errorMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as ApiErrorEnvelope
  return payload.error?.message || `Request failed (${response.status})`
}

const HISTORY_DAY_OPTIONS = [30, 60, 90] as const
const DECIMAL_OPTIONS = [
  { value: 0, label: "0 decimals (99%)" },
  { value: 1, label: "1 decimal (99.9%)" },
  { value: 2, label: "2 decimals (99.99%)" },
  { value: 3, label: "3 decimals (99.987%)" },
]
const MIN_INCIDENT_OPTIONS = [
  { value: 0, label: "Show everything" },
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 120, label: "2 minutes" },
  { value: 300, label: "5 minutes" },
  { value: 600, label: "10 minutes" },
  { value: 1800, label: "30 minutes" },
]

/** CLI-set values outside the presets still render and round-trip intact. */
function minIncidentOptionsIncluding(value: number) {
  return MIN_INCIDENT_OPTIONS.some((option) => option.value === value)
    ? MIN_INCIDENT_OPTIONS
    : [...MIN_INCIDENT_OPTIONS, { value, label: `${value} seconds` }].sort(
        (left, right) => left.value - right.value
      )
}

const publicTimezoneOptions = [
  { label: "UTC", value: "UTC" },
  ...timezoneOptions.filter(
    (zone) => zone.value !== "system" && zone.value !== "UTC"
  ),
]

function timezoneOptionsIncluding(value: string) {
  return publicTimezoneOptions.some((zone) => zone.value === value)
    ? publicTimezoneOptions
    : [...publicTimezoneOptions, { label: value, value }]
}

const layoutOptions: {
  value: StatusPageConfigDocument["layout"]
  label: string
  description: string
}[] = [
  {
    value: "vertical",
    label: "Vertical",
    description: "Logo above the page title",
  },
  {
    value: "horizontal",
    label: "Horizontal",
    description: "Logo, title, and links in one row",
  },
]

function LayoutThumbnail({
  variant,
}: {
  variant: StatusPageConfigDocument["layout"]
}) {
  return (
    <svg
      aria-hidden
      className="block"
      focusable="false"
      height="56"
      viewBox="0 0 88 56"
      width="88"
    >
      <rect fill="var(--bg)" height="56" width="88" />
      {variant === "vertical" ? (
        <>
          <rect
            fill="var(--fg-faint)"
            height="6"
            rx="2"
            width="14"
            x="6"
            y="6"
          />
          <rect
            fill="var(--fg-muted)"
            height="3"
            rx="1.5"
            width="30"
            x="6"
            y="16"
          />
          <rect
            fill="var(--chip-bg)"
            height="12"
            rx="3"
            width="76"
            x="6"
            y="24"
          />
          <rect
            fill="var(--chip-bg)"
            height="12"
            rx="3"
            width="76"
            x="6"
            y="40"
          />
        </>
      ) : (
        <>
          <rect
            fill="var(--fg-faint)"
            height="6"
            rx="2"
            width="14"
            x="6"
            y="7"
          />
          <rect
            fill="var(--fg-muted)"
            height="3"
            rx="1.5"
            width="24"
            x="24"
            y="8.5"
          />
          <rect
            fill="var(--fg-faint)"
            height="3"
            rx="1.5"
            width="10"
            x="58"
            y="8.5"
          />
          <rect
            fill="var(--fg-faint)"
            height="3"
            rx="1.5"
            width="10"
            x="72"
            y="8.5"
          />
          <rect
            fill="var(--chip-bg)"
            height="14"
            rx="3"
            width="76"
            x="6"
            y="20"
          />
          <rect
            fill="var(--chip-bg)"
            height="14"
            rx="3"
            width="76"
            x="6"
            y="38"
          />
        </>
      )}
    </svg>
  )
}

function LayoutPicker({
  value,
  onChange,
}: {
  value: StatusPageConfigDocument["layout"]
  onChange: (value: StatusPageConfigDocument["layout"]) => void
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])

  function onKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0
    if (!delta) {
      return
    }
    event.preventDefault()
    const next = (index + delta + layoutOptions.length) % layoutOptions.length
    onChange(layoutOptions[next]!.value)
    buttons.current[next]?.focus()
  }

  return (
    <div
      aria-label="Header layout"
      className="flex flex-wrap gap-3"
      role="radiogroup"
    >
      {layoutOptions.map((option, index) => {
        const selected = value === option.value
        return (
          <button
            aria-checked={selected}
            className="group flex flex-col items-start gap-1.5 rounded-[8px]"
            key={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            ref={(element) => {
              buttons.current[index] = element
            }}
            role="radio"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            <span
              className={cn(
                "overflow-hidden rounded-[6px] border transition-shadow duration-150",
                selected
                  ? "border-[var(--focus)] shadow-[0_0_0_2px_var(--focus)]"
                  : "border-[var(--border-strong)] group-hover:border-[var(--border-hover)]"
              )}
            >
              <LayoutThumbnail variant={option.value} />
            </span>
            <span
              className={cn(
                "px-0.5 text-[12px]",
                selected
                  ? "font-medium text-[var(--fg)]"
                  : "text-[var(--fg-muted)]"
              )}
            >
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// Client mirror of the server caps in lib/api/images.ts
// (MAX_IMAGE_BYTES / MAX_FAVICON_BYTES) so bad files fail before the upload.
const MAX_UPLOAD_BYTES = 512 * 1024
const MAX_FAVICON_UPLOAD_BYTES = 32 * 1024
const LOGO_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
]
const FAVICON_MIME_TYPES = [
  "image/png",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/svg+xml",
]

export function uploadValidationError(
  kind: "logo-light" | "logo-dark" | "favicon",
  file: File
): string {
  const favicon = kind === "favicon"
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? ""
  if (!(favicon ? FAVICON_MIME_TYPES : LOGO_MIME_TYPES).includes(type)) {
    return favicon
      ? "Use a PNG, ICO, or SVG file."
      : "Use a PNG, JPEG, SVG, or WebP image."
  }
  if (file.size > (favicon ? MAX_FAVICON_UPLOAD_BYTES : MAX_UPLOAD_BYTES)) {
    return favicon
      ? "Favicon files must be at most 32 KB."
      : "Images must be at most 512 KB."
  }
  return ""
}

function ImageUploadZone({
  label,
  kind,
  imageId,
  savedImageId,
  onChange,
  hint,
}: {
  label: string
  kind: "logo-light" | "logo-dark" | "favicon"
  imageId: string | null
  /** The id in the last-saved document, used to distinguish persisted from pending. */
  savedImageId: string | null
  onChange: (imageId: string | null) => void
  hint: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [localPreview, setLocalPreview] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  // Image ids rotate on every upload, so a draft id differing from the saved
  // one always means "uploaded this session, pending the page-level save".
  const freshUpload = imageId !== null && imageId !== savedImageId

  async function upload(file: File) {
    const preflightError = uploadValidationError(kind, file)
    if (preflightError) {
      setError(preflightError)
      if (inputRef.current) {
        inputRef.current.value = ""
      }
      return
    }
    setBusy(true)
    setError("")
    try {
      const form = new FormData()
      form.append("file", file)
      form.append("kind", kind)
      const response = await fetch("/api/v1/images", {
        method: "POST",
        body: form,
      })
      if (!response.ok) {
        throw new Error(await errorMessage(response))
      }
      const payload = (await response.json()) as { data?: { id?: string } }
      if (!payload.data?.id) {
        throw new Error("Upload failed. Try again.")
      }
      if (
        typeof URL !== "undefined" &&
        typeof URL.createObjectURL === "function"
      ) {
        setLocalPreview(URL.createObjectURL(file))
      }
      onChange(payload.data.id)
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Upload failed. Try again."
      )
    } finally {
      setBusy(false)
      if (inputRef.current) {
        inputRef.current.value = ""
      }
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
      : null
  const noun = kind === "favicon" ? "favicon" : "logo"
  const statusText = busy
    ? "Uploading…"
    : imageId
      ? freshUpload
        ? "Ready — save to apply"
        : `Current ${noun} — saved`
      : hint

  return (
    <div>
      <p className="mb-2 font-medium text-[13px]">{label}</p>
      <div
        className={cn(
          "flex min-h-[84px] items-center justify-between gap-3 rounded-[8px] border border-dashed px-4 py-3 transition-colors duration-100",
          dragOver
            ? "border-[var(--focus)] bg-[var(--hover)]"
            : "border-[var(--border-strong)]"
        )}
        onDragEnter={() => setDragOver(true)}
        onDragLeave={() => setDragOver(false)}
        onDragOver={(event) => {
          event.preventDefault()
          setDragOver(true)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragOver(false)
          const file = event.dataTransfer.files?.[0]
          if (file && !busy) {
            void upload(file)
          }
        }}
      >
        <div className="flex min-w-0 items-center gap-3">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- uploaded bytes, not an optimizable static asset
            // biome-ignore lint/correctness/useImageSize: uploaded logo of unknown intrinsic size, css object-contain bounds the preview
            <img
              alt=""
              aria-hidden
              className="max-h-10 max-w-[96px] rounded-[4px] object-contain"
              src={previewUrl}
            />
          ) : null}
          <p className="text-[13px] text-[var(--fg-muted)]">{statusText}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            size="sm"
            type="button"
            variant="secondary"
          >
            Browse
          </Button>
          {imageId ? (
            <Button
              disabled={busy}
              onClick={() => {
                setLocalPreview(null)
                onChange(null)
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              Remove
            </Button>
          ) : null}
        </div>
      </div>
      <input
        accept={
          kind === "favicon"
            ? "image/png,image/x-icon,image/svg+xml"
            : "image/png,image/jpeg,image/svg+xml,image/webp"
        }
        aria-label={label}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) {
            void upload(file)
          }
        }}
        ref={inputRef}
        type="file"
      />
      {error ? (
        <p className="mt-1 text-[var(--down-text)] text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function CheckboxRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string
  label: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start gap-2.5">
      <input
        checked={checked}
        className="mt-0.5 size-4 accent-[var(--fg)]"
        id={id}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <label className="min-w-0" htmlFor={id}>
        <span className="block font-medium text-[13px]">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-[13px] text-[var(--fg-muted)]">
            {description}
          </span>
        ) : null}
      </label>
    </div>
  )
}

const textareaClass =
  "w-full resize-y rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 text-[13px] leading-5"

export function StatusPageSettings({ data }: { data: StatusPageSettingsData }) {
  const router = useRouter()
  const [saved, setSaved] = useState<StatusPageConfigDocument>(() =>
    toDocument(data.config)
  )
  const [draft, setDraft] = useState<StatusPageConfigDocument>(() =>
    structuredClone(toDocument(data.config))
  )
  const [etag, setEtag] = useState(data.etag)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  // Link-row validation only surfaces on a save attempt, so a
  // just-added empty row never fires an instant alert.
  const [navLinksError, setNavLinksError] = useState("")
  const statusRef = useRef<HTMLParagraphElement>(null)

  const dirty = !documentsEqual(draft, saved)
  useDirtyGuard("status-page", dirty)

  // Latest-value refs for the mount-only revalidation effect below. Written
  // during render, never read during render, so the effect's async callback
  // always sees the current draft, saved, and etag when its fetch resolves.
  const draftRef = useRef(draft)
  const savedRef = useRef(saved)
  const etagRef = useRef(etag)
  draftRef.current = draft
  savedRef.current = saved
  etagRef.current = etag

  // A remount can hydrate from a cached snapshot (client router cache,
  // prefetched payload, bfcache) whose etag is stale. Saving with that etag
  // 412s against the user's own previous save and surfaces as a phantom
  // "changed elsewhere" conflict. Revalidate once on mount and adopt the
  // server document only while the form is pristine. A form the user has
  // already edited is left alone, the existing 412 recovery covers it.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const response = await fetch("/api/v1/status-page-config", {
          cache: "no-store",
        })
        if (!response.ok) {
          return
        }
        const nextEtag = response.headers.get("ETag")
        const payload = (await response.json()) as {
          data: StatusPageConfigDocument
        }
        if (cancelled || !nextEtag || nextEtag === etagRef.current) {
          return
        }
        if (!documentsEqual(draftRef.current, savedRef.current)) {
          return
        }
        const server = toDocument(payload.data)
        setEtag(nextEtag)
        setSaved(server)
        setDraft(structuredClone(server))
      } catch {
        // Revalidation is best-effort. A stale etag still recovers through
        // the conflict path on save.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  function update(patch: Partial<StatusPageConfigDocument>) {
    if (patch.navLinks) {
      setNavLinksError("")
    }
    setDraft((current) => ({ ...current, ...patch }))
  }

  function textOrNull(value: string): string | null {
    return value === "" ? null : value
  }

  const nameError = draft.name.trim() ? "" : "Page name is required"

  async function save() {
    if (busy || nameError) {
      return
    }
    // Fully-empty rows are dropped. Partially-filled rows block the save.
    const navLinks = draft.navLinks.filter(
      (link) => link.label.trim() || link.url.trim()
    )
    if (navLinks.some((link) => !(link.label.trim() && link.url.trim()))) {
      setNavLinksError("Every link needs a label and a URL")
      return
    }
    setNavLinksError("")
    setBusy(true)
    setMessage(null)
    const document = toDocument({ ...draft, navLinks })
    try {
      const response = await fetch("/api/v1/status-page-config", {
        method: "PUT",
        // The config PUT route requires a UUID Idempotency-Key (executeIdempotent).
        // Without it every save fails with IDEMPOTENCY_KEY_REQUIRED.
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(document),
      })
      if (response.status === 412) {
        await recoverFromConflict()
        return
      }
      if (!response.ok) {
        throw new Error(await errorMessage(response))
      }
      const nextEtag = response.headers.get("ETag")
      setSaved(document)
      setDraft(structuredClone(document))
      if (nextEtag) {
        setEtag(nextEtag)
      }
      setMessage({ text: "Status page settings saved", tone: "info" })
      // The sticky bar (and the focused Save button) unmounts on success.
      // Hand focus to the always-mounted status region instead of <body>.
      statusRef.current?.focus()
      router.refresh()
    } catch (error) {
      setMessage({
        text:
          error instanceof Error ? error.message : "Request failed. Try again.",
        tone: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  async function recoverFromConflict() {
    try {
      const response = await fetch("/api/v1/status-page-config")
      if (!response.ok) {
        throw new Error(await errorMessage(response))
      }
      const payload = (await response.json()) as {
        data: StatusPageConfigDocument
      }
      const server = toDocument(payload.data)
      const nextEtag = response.headers.get("ETag")
      setDraft(mergeStatusPageDrafts(saved, draft, server))
      setSaved(server)
      if (nextEtag) {
        setEtag(nextEtag)
      }
      setMessage({
        text: "Settings changed elsewhere — your edits are preserved, review and save again",
        tone: "error",
      })
    } catch (error) {
      setMessage({
        text:
          error instanceof Error ? error.message : "Request failed. Try again.",
        tone: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  function discard() {
    setDraft(structuredClone(saved))
    setNavLinksError("")
    setMessage({ text: "Changes discarded", tone: "info" })
    // The sticky bar unmounts. Keep focus on something real.
    statusRef.current?.focus()
  }

  const announcementPreview = draft.announcementEnabled
    ? (draft.announcementMarkdown ?? "").trim()
    : ""

  return (
    <div className="space-y-6">
      <Card>
        <CardHeading title="Personalization" />
        <CardContent className="pt-0">
          <div className="max-w-[640px] space-y-5">
            <Field
              error={nameError || undefined}
              htmlFor="sp-name"
              label="Page name"
            >
              <Input
                aria-invalid={Boolean(nameError) || undefined}
                className="max-w-[320px]"
                id="sp-name"
                inputSize="sm"
                maxLength={80}
                onChange={(event) => update({ name: event.target.value })}
                value={draft.name}
              />
            </Field>
            <div>
              <p className="mb-2 font-medium text-[13px]">Header layout</p>
              <LayoutPicker
                onChange={(layout) => update({ layout })}
                value={draft.layout}
              />
            </div>
            <div>
              <p className="mb-2 font-medium text-[13px]">Theme</p>
              <Select
                onValueChange={(theme) =>
                  update({ theme: theme as StatusPageConfigDocument["theme"] })
                }
                value={draft.theme}
              >
                <SelectTrigger aria-label="Page theme" className="w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">
                    Follow the visitor&rsquo;s device
                  </SelectItem>
                  <SelectItem value="light">Always light</SelectItem>
                  <SelectItem value="dark">Always dark</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ImageUploadZone
              hint="Drop an image or browse — PNG, JPEG, SVG, or WebP up to 512 KB"
              imageId={draft.logoLightImageId}
              kind="logo-light"
              label="Logo (light theme)"
              onChange={(logoLightImageId) => update({ logoLightImageId })}
              savedImageId={saved.logoLightImageId}
            />
            <ImageUploadZone
              hint="Drop an image or browse — PNG, JPEG, SVG, or WebP up to 512 KB"
              imageId={draft.logoDarkImageId}
              kind="logo-dark"
              label="Logo (dark theme)"
              onChange={(logoDarkImageId) => update({ logoDarkImageId })}
              savedImageId={saved.logoDarkImageId}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeading title="Links & URLs" />
        <CardContent className="pt-0">
          <div className="max-w-[640px] space-y-4">
            <Field
              description="The logo links here when set."
              htmlFor="sp-homepage"
              label="Homepage URL"
            >
              <Input
                className="max-w-[420px] font-data"
                id="sp-homepage"
                inputSize="sm"
                onChange={(event) =>
                  update({ homepageUrl: textOrNull(event.target.value) })
                }
                placeholder="https://example.com"
                type="url"
                value={draft.homepageUrl ?? ""}
              />
            </Field>
            <Field
              description={
                'Shows a "Get in touch" button. Web addresses and mailto: links work.'
              }
              htmlFor="sp-contact"
              label="Contact URL"
            >
              <Input
                className="max-w-[420px] font-data"
                id="sp-contact"
                inputSize="sm"
                onChange={(event) =>
                  update({ contactUrl: textOrNull(event.target.value) })
                }
                placeholder="mailto:support@example.com"
                value={draft.contactUrl ?? ""}
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
              checked={draft.announcementEnabled}
              description="Displayed above the status banner on the public page."
              id="sp-announcement-enabled"
              label="Show announcement"
              onChange={(announcementEnabled) =>
                update({ announcementEnabled })
              }
            />
            <label className="block">
              <span className="mb-2 block font-medium text-[13px]">
                Announcement
              </span>
              <textarea
                aria-label="Announcement markdown"
                className={textareaClass}
                onChange={(event) =>
                  update({
                    announcementMarkdown: textOrNull(event.target.value),
                  })
                }
                placeholder="Scheduled maintenance this Saturday…"
                rows={4}
                value={draft.announcementMarkdown ?? ""}
              />
              <span className="mt-1 block text-[var(--fg-muted)] text-xs">
                Supports [links](https://…), **bold**, *italic*, and `code`. Up
                to 2 KB.
              </span>
            </label>
            {announcementPreview ? (
              <div
                aria-label="Announcement preview"
                className="rounded-[8px] border border-[var(--border)] bg-[var(--chip-bg)] p-4"
                role="group"
              >
                <div className="space-y-2 text-[13px] leading-[19px]">
                  {announcementPreview
                    .split(/\n[\t ]*\n+/)
                    .map((paragraph, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: static preview split re-rendered wholesale on every edit
                      <p className="whitespace-pre-wrap" key={index}>
                        {paragraph.trim()}
                      </p>
                    ))}
                </div>
                <p className="mt-3 border-[var(--border)] border-t pt-2 text-[var(--fg-faint)] text-xs">
                  Plain-text preview — markdown formatting is applied on the
                  published page.
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
              hint="Drop an image or browse — PNG, ICO, or SVG up to 32 KB"
              imageId={draft.faviconImageId}
              kind="favicon"
              label="Favicon"
              onChange={(faviconImageId) => update({ faviconImageId })}
              savedImageId={saved.faviconImageId}
            />
            <div>
              <p className="mb-2 font-medium text-[13px]">Display time zone</p>
              <Select
                onValueChange={(timezone) =>
                  update({ timezone: timezone === "UTC" ? null : timezone })
                }
                value={draft.timezone ?? "UTC"}
              >
                <SelectTrigger
                  aria-label="Display time zone"
                  className="w-[280px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {timezoneOptionsIncluding(draft.timezone ?? "UTC").map(
                    (zone) => (
                      <SelectItem key={zone.value} value={zone.value}>
                        {zone.label}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[var(--fg-faint)] text-xs">
                Public page timestamps display in this zone, labeled with its
                offset.
              </p>
            </div>
            <label className="block">
              <span className="mb-2 block font-medium text-[13px]">
                Custom CSS
              </span>
              <textarea
                aria-label="Custom CSS"
                className={cn(textareaClass, "font-data")}
                onChange={(event) =>
                  update({ customCss: textOrNull(event.target.value) })
                }
                rows={6}
                spellCheck={false}
                value={draft.customCss ?? ""}
              />
              <span className="mt-1 block text-[var(--fg-muted)] text-xs">
                Injected into the public page as a style tag. Up to 10 KB.
              </span>
            </label>
            <label className="block">
              <span className="mb-2 block font-medium text-[13px]">
                Custom HTML
              </span>
              <textarea
                aria-label="Custom HTML"
                className={cn(textareaClass, "font-data")}
                onChange={(event) =>
                  update({ customHead: textOrNull(event.target.value) })
                }
                rows={6}
                spellCheck={false}
                value={draft.customHead ?? ""}
              />
              <span className="mt-1 block text-[var(--fg-muted)] text-xs">
                Raw markup injected at the top of the public page&rsquo;s body,
                not the document &lt;head&gt; — tools that only read the head,
                like meta-tag site verifiers, will not see it. Scripts and
                styles run as written. Up to 10 KB.
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
              <p className="mb-2 font-medium text-[13px]">History window</p>
              <Select
                onValueChange={(value) =>
                  update({
                    historyDays: Number(
                      value
                    ) as StatusPageConfigDocument["historyDays"],
                  })
                }
                value={String(draft.historyDays)}
              >
                <SelectTrigger
                  aria-label="History window"
                  className="w-[220px]"
                >
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
              <p className="mt-1 text-[var(--fg-faint)] text-xs">
                Timelines and uptime figures cover this window.
              </p>
            </div>
            <div>
              <p className="mb-2 font-medium text-[13px]">Uptime precision</p>
              <Select
                onValueChange={(value) =>
                  update({ uptimeDecimals: Number(value) })
                }
                value={String(draft.uptimeDecimals)}
              >
                <SelectTrigger
                  aria-label="Uptime precision"
                  className="w-[220px]"
                >
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
              <p className="mb-2 font-medium text-[13px]">
                Hide resolved blips shorter than
              </p>
              <Select
                onValueChange={(value) =>
                  update({ minIncidentSeconds: Number(value) })
                }
                value={String(draft.minIncidentSeconds)}
              >
                <SelectTrigger
                  aria-label="Hide resolved blips shorter than"
                  className="w-[220px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {minIncidentOptionsIncluding(draft.minIncidentSeconds).map(
                    (option) => (
                      <SelectItem
                        key={option.value}
                        value={String(option.value)}
                      >
                        {option.label}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[var(--fg-faint)] text-xs">
                Hides short resolved incidents from incident history. Timelines
                always reflect raw availability.
              </p>
            </div>
            <CheckboxRow
              checked={draft.unknownAsOperational}
              description="Timeline stretches without data render as operational instead of gray."
              id="sp-unknown-operational"
              label="Show unknown periods as operational"
              onChange={(unknownAsOperational) =>
                update({ unknownAsOperational })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeading title="Analytics & Navigation" />
        <CardContent className="pt-0">
          <div className="max-w-[640px] space-y-5">
            <Field
              description="G-XXXXXXX or GT-XXXXXXX. The tag script is emitted on the public page only."
              htmlFor="sp-google-tag"
              label="Google tag ID"
            >
              <Input
                className="max-w-[240px] font-data"
                id="sp-google-tag"
                inputSize="sm"
                onChange={(event) =>
                  update({
                    googleTagId: textOrNull(
                      event.target.value.toUpperCase().trim()
                    ),
                  })
                }
                placeholder="G-XXXXXXXXXX"
                value={draft.googleTagId ?? ""}
              />
            </Field>
            <div>
              <p className="font-medium text-[13px]">Navigation links</p>
              <p className="mt-0.5 text-[13px] text-[var(--fg-muted)]">
                Shown in the public page header. Up to {MAX_NAV_LINKS} links.
              </p>
              {draft.navLinks.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {draft.navLinks.map((link, index) => (
                    <div
                      className="flex flex-wrap items-center gap-2"
                      // biome-ignore lint/suspicious/noArrayIndexKey: editable rows have no stable id, controlled inputs bind by position
                      key={index}
                    >
                      <Input
                        aria-label={`Link ${index + 1} label`}
                        className="w-[160px]"
                        inputSize="sm"
                        maxLength={40}
                        onChange={(event) => {
                          const navLinks = draft.navLinks.map((entry, at) =>
                            at === index
                              ? { ...entry, label: event.target.value }
                              : entry
                          )
                          update({ navLinks })
                        }}
                        placeholder="Label"
                        value={link.label}
                      />
                      <Input
                        aria-label={`Link ${index + 1} URL`}
                        className="min-w-[220px] flex-1 font-data"
                        inputSize="sm"
                        onChange={(event) => {
                          const navLinks = draft.navLinks.map((entry, at) =>
                            at === index
                              ? { ...entry, url: event.target.value }
                              : entry
                          )
                          update({ navLinks })
                        }}
                        placeholder="https://example.com"
                        value={link.url}
                      />
                      <Button
                        aria-label={`Remove link ${index + 1}`}
                        onClick={() =>
                          update({
                            navLinks: draft.navLinks.filter(
                              (_, at) => at !== index
                            ),
                          })
                        }
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
              {navLinksError ? (
                <p
                  className="mt-2 text-[var(--down-text)] text-xs"
                  role="alert"
                >
                  {navLinksError}
                </p>
              ) : null}
              <Button
                className="mt-3"
                disabled={draft.navLinks.length >= MAX_NAV_LINKS}
                onClick={() =>
                  update({
                    navLinks: [...draft.navLinks, { label: "", url: "" }],
                  })
                }
                size="sm"
                type="button"
                variant="secondary"
              >
                Add Link
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <StatusMessage message={message} ref={statusRef} />

      {/* Always-mounted announcer: says "Unsaved changes" once when the bar
          first appears, then stays silent until the next clean→dirty edge. */}
      <p aria-live="polite" className="sr-only">
        {dirty ? "Unsaved changes" : ""}
      </p>

      {dirty ? (
        <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg)] px-4 py-3 shadow-[var(--card-shadow)]">
          <p className="font-medium text-[13px]">Unsaved changes</p>
          <div className="flex gap-2">
            <Button
              disabled={busy}
              onClick={discard}
              size="sm"
              type="button"
              variant="secondary"
            >
              Discard
            </Button>
            <Button
              disabled={busy || Boolean(nameError)}
              onClick={() => void save()}
              size="sm"
              type="button"
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
