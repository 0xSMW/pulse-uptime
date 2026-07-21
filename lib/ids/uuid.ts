// Strict RFC 4122 shape: version nibble 1-5 and variant nibble 8, 9, a, or b.
// App-generated IDs are v4 or v5, so this accepts them and rejects malformed
// input. Pure and client-safe, no server-only imports.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}
