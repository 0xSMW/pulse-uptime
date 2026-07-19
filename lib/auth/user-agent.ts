/**
 * Dependency-free user-agent display parser for the Security page's session
 * list. Family and major version only, no device fingerprinting, no data files.
 */

export type ParsedUserAgent = {
  browser: string;
  os: string;
};

export const UNKNOWN_BROWSER = "Unknown browser";
export const UNKNOWN_OS = "Unknown OS";

function withMajor(family: string, version: string | undefined): string {
  const major = version?.split(".")[0];
  return major ? `${family} ${major}` : family;
}

function parseBrowser(userAgent: string): string {
  const pulsectl = /\bpulsectl\/(\d[\w.-]*)/.exec(userAgent);
  if (pulsectl) return withMajor("pulsectl", pulsectl[1]);

  // Order matters: Edge and Opera embed Chrome/..., and Chrome embeds Safari/....
  const edge = /\bEdg(?:e|A|iOS)?\/(\d[\d.]*)/.exec(userAgent);
  if (edge) return withMajor("Edge", edge[1]);

  const firefox = /\b(?:Firefox|FxiOS)\/(\d[\d.]*)/.exec(userAgent);
  if (firefox) return withMajor("Firefox", firefox[1]);

  const chrome = /\b(?:Chrome|CriOS)\/(\d[\d.]*)/.exec(userAgent);
  if (chrome) return withMajor("Chrome", chrome[1]);

  if (/\bSafari\//.test(userAgent)) {
    const version = /\bVersion\/(\d[\d.]*)/.exec(userAgent);
    return version ? withMajor("Safari", version[1]) : "Safari";
  }

  return UNKNOWN_BROWSER;
}

function parseOs(userAgent: string): string {
  // iOS first: iPad and iPhone user agents also claim "like Mac OS X".
  if (/\b(?:iPhone|iPad|iPod)\b/.test(userAgent)) return "iOS";
  if (/\bWindows\b/i.test(userAgent)) return "Windows";
  if (/\bAndroid\b/.test(userAgent)) return "Android";
  if (/\bCrOS\b/.test(userAgent)) return "ChromeOS";
  if (/\b(?:Macintosh|Mac OS X)\b/.test(userAgent) || /\bdarwin\b/i.test(userAgent)) return "macOS";
  if (/\blinux\b/i.test(userAgent)) return "Linux";
  return UNKNOWN_OS;
}

export function parseUserAgent(userAgent: string | null | undefined): ParsedUserAgent {
  const value = userAgent?.trim();
  if (!value) return { browser: UNKNOWN_BROWSER, os: UNKNOWN_OS };
  return { browser: parseBrowser(value), os: parseOs(value) };
}
