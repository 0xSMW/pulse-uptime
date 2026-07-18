import ipaddr from "ipaddr.js";

const PUBLIC_RANGE = "unicast";

export class BlockedTargetError extends Error {
  readonly code = "BLOCKED_TARGET";

  constructor(message = "Target address is not publicly routable") {
    super(message);
    this.name = "BlockedTargetError";
  }
}

export function parseIpAddress(address: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  try {
    if (!ipaddr.isValid(address)) return null;
    return ipaddr.parse(address);
  } catch {
    return null;
  }
}

export function isPublicAddress(address: string): boolean {
  const parsed = parseIpAddress(address);
  if (!parsed) return false;

  if (parsed.kind() === "ipv4") {
    return parsed.range() === PUBLIC_RANGE;
  }

  const ipv6 = parsed as ipaddr.IPv6;
  if (ipv6.isIPv4MappedAddress()) {
    return ipv6.toIPv4Address().range() === PUBLIC_RANGE;
  }

  return ipv6.range() === PUBLIC_RANGE;
}

export function assertPublicAddress(address: string): void {
  if (!isPublicAddress(address)) throw new BlockedTargetError();
}

export function isIpLiteral(hostname: string): boolean {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return parseIpAddress(unwrapped) !== null;
}

export function normalizeIpLiteral(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}
