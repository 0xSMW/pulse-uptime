// Single source of truth for the public HTTP URL policy shared by the config
// schema, the secure checker, and both monitor edit surfaces. Pure and
// client-safe: no server-only imports and no node built-ins, so it runs
// unchanged in the browser and on the server.

function isReservedIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = octets;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isReservedIpv6(host: string): boolean {
  // Fold leading zeros within each group so short and zero-padded spellings of
  // the same reserved prefix collapse to one form before the prefix match.
  const compact = host.replace(/(^|:)0+(?=[0-9a-f])/g, "$1");
  return (
    compact === "::" || compact === "::1" ||
    compact.startsWith("fc") || compact.startsWith("fd") ||
    compact.startsWith("fe8") || compact.startsWith("fe9") ||
    compact.startsWith("fea") || compact.startsWith("feb") ||
    compact.startsWith("ff") || compact.startsWith("::ffff:") ||
    compact.startsWith("2001:db8:")
  );
}

function hasAllowedPort(url: URL): boolean {
  // Only the default HTTP and HTTPS ports are reachable public destinations,
  // and each scheme is pinned to its own port so a scheme/port mismatch fails.
  if (url.port && url.port !== "80" && url.port !== "443") return false;
  if (url.protocol === "http:" && url.port === "443") return false;
  if (url.protocol === "https:" && url.port === "80") return false;
  return true;
}

export function isPublicHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (!hasAllowedPort(url)) return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;

  // DNS resolution and rebinding protection belong to the secure checker. These
  // checks reject literal addresses that are never valid public destinations.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !isReservedIpv4(host);
  if (host.includes(":")) return !isReservedIpv6(host);
  return true;
}
