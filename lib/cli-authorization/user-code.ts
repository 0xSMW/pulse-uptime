const USER_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/

export type ParsedUserCode =
  | { ok: true; code: string }
  | { ok: false; message: string }

export function parseUserCodeInput(value: string): ParsedUserCode {
  const trimmed = value.trim()
  if (!trimmed) {
    return { ok: false, message: "Enter the code shown in your terminal" }
  }

  let candidate = trimmed
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      if (!url.pathname.endsWith("/cli/authorize")) {
        return { ok: false, message: "Enter a Pulse authorization URL" }
      }
      candidate = url.searchParams.get("user_code") ?? ""
    } catch {
      return { ok: false, message: "Enter a valid code or authorization URL" }
    }
  }

  const compact = candidate.toUpperCase().replace(/[\s-]/g, "")
  if (!/^[A-Z0-9]{8}$/.test(compact)) {
    return {
      ok: false,
      message: "Enter the eight-character code from your terminal",
    }
  }

  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`
  return USER_CODE_PATTERN.test(code)
    ? { ok: true, code }
    : { ok: false, message: "Enter a valid authorization code" }
}
