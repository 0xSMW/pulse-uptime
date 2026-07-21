/**
 * Derives up to two avatar initials from a display name, falling back to the
 * first letter of the email when no name is set. Shared by the settings profile
 * card and the dashboard user menu. Both call sites gate on a set name and show
 * the neutral User glyph otherwise, so the email fallback only applies when a
 * caller passes it a name it cannot reduce to initials.
 */
export function initialsFor(name: string | null, email: string): string {
  const source = name?.trim() || ""
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean)
    const first = parts[0]?.[0] ?? ""
    const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : ""
    return `${first}${last}`.toUpperCase()
  }
  return email[0]?.toUpperCase() ?? ""
}
