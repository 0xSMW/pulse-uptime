import { z } from "zod";

/**
 * Validation for the status page configuration document (PUT
 * /api/v1/status-page-config). Shared by the API route and the settings UI, so
 * this module must stay importable from client components (no server-only).
 */

export const STATUS_PAGE_NAME_FALLBACK = "System Status";
export const STATUS_PAGE_LAYOUTS = ["vertical", "horizontal"] as const;
export const STATUS_PAGE_THEMES = ["system", "light", "dark"] as const;
export const STATUS_PAGE_HISTORY_DAYS = [30, 60, 90] as const;
export const MAX_NAV_LINKS = 8;
export const MAX_CUSTOM_BYTES = 10 * 1024;
export const MAX_ANNOUNCEMENT_BYTES = 2 * 1024;
export const MAX_MIN_INCIDENT_SECONDS = 7 * 86_400;

export function isValidIanaTimeZone(value: string): boolean {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function schemeUrl(schemes: readonly string[]) {
  return z.string().min(1).max(2048).refine((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    return schemes.includes(parsed.protocol.replace(/:$/, ""));
  }, { message: `URL must use one of: ${schemes.join(", ")}` });
}

const httpUrl = schemeUrl(["http", "https"]);
const httpOrMailtoUrl = schemeUrl(["http", "https", "mailto"]);

const boundedText = (maxBytes: number) =>
  z.string().refine((value) => utf8Bytes(value) <= maxBytes, {
    message: `Must be at most ${maxBytes} bytes`,
  });

export const navLinkSchema = z.strictObject({
  label: z.string().trim().min(1).max(40),
  url: httpOrMailtoUrl,
});

export const statusPageConfigDocumentSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  layout: z.enum(STATUS_PAGE_LAYOUTS),
  theme: z.enum(STATUS_PAGE_THEMES),
  logoLightImageId: z.uuid().nullable(),
  logoDarkImageId: z.uuid().nullable(),
  faviconImageId: z.uuid().nullable(),
  homepageUrl: httpUrl.nullable(),
  contactUrl: httpOrMailtoUrl.nullable(),
  navLinks: z.array(navLinkSchema).max(MAX_NAV_LINKS),
  googleTagId: z.string().regex(/^G(T)?-[A-Z0-9]+$/, "Must look like G-XXXXXXX or GT-XXXXXXX").max(40).nullable(),
  customCss: boundedText(MAX_CUSTOM_BYTES).nullable(),
  customHead: boundedText(MAX_CUSTOM_BYTES).nullable(),
  announcementEnabled: z.boolean(),
  announcementMarkdown: boundedText(MAX_ANNOUNCEMENT_BYTES).nullable(),
  historyDays: z.union([z.literal(30), z.literal(60), z.literal(90)]),
  uptimeDecimals: z.int().min(0).max(3),
  unknownAsOperational: z.boolean(),
  minIncidentSeconds: z.int().min(0).max(MAX_MIN_INCIDENT_SECONDS),
  timezone: z.string().refine(isValidIanaTimeZone, { message: "Must be a valid IANA time zone" }).nullable(),
});

export type StatusPageConfigDocument = z.infer<typeof statusPageConfigDocumentSchema>;
export type StatusPageNavLink = z.infer<typeof navLinkSchema>;

/**
 * Parses a full replacement document. Read-side fields (updatedAt, the CLI
 * export's _etag) are stripped rather than rejected so a GET/export response
 * can be edited and sent straight back.
 */
export function parseStatusPageConfigDocument(input: unknown) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const { updatedAt: _updatedAt, _etag, ...rest } = input as Record<string, unknown>;
    void _updatedAt;
    void _etag;
    return statusPageConfigDocumentSchema.safeParse(rest);
  }
  return statusPageConfigDocumentSchema.safeParse(input);
}
