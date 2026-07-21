export function parseMonitorRecipients(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((recipient) => recipient.trim())
    .filter(Boolean)
}
