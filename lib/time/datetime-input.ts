/**
 * Converts between instants and `<input type="datetime-local">` values in an
 * explicit IANA time zone. Pure and client-safe.
 *
 * A wall time can map to zero instants (skipped by a daylight-saving jump) or
 * to two (repeated when clocks fall back). Parsing reports both cases instead
 * of shifting the value, so callers decide how to handle them.
 */

export type DatetimeInputParse =
  | { status: "ok"; iso: string }
  | { status: "ambiguous"; earlier: string; later: string }
  | { status: "nonexistent" }
  | { status: "invalid" }

const INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
const DAY_MS = 86_400_000

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZone,
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallTime(ms: number, timeZone: string): WallTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms))
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN)
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // Some engines render midnight as 24 even with h23.
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  }
}

/** Milliseconds for a wall time read as if it were UTC. */
function wallAsUtc(wall: WallTime): number {
  const date = new Date(0)
  date.setUTCFullYear(wall.year, wall.month - 1, wall.day)
  date.setUTCHours(wall.hour, wall.minute, wall.second, 0)
  return date.getTime()
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  )
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0")
}

/**
 * Renders an instant as a datetime-local value in `timeZone`, to the minute.
 * Returns an empty string for an unparseable instant.
 */
export function formatDatetimeInput(iso: string, timeZone: string): string {
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) {
    return ""
  }
  const wall = wallTime(Math.floor(ms / 1000) * 1000, timeZone)
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`
}

/** Reads a datetime-local value as a wall time in `timeZone`. */
export function parseDatetimeInput(
  value: string,
  timeZone: string
): DatetimeInputParse {
  const match = INPUT_PATTERN.exec(value.trim())
  if (!match) {
    return { status: "invalid" }
  }
  const wall: WallTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  }
  const { year, month, day, hour, minute, second } = wall
  const guess = wallAsUtc(wall)
  // Out-of-range fields such as Feb 30 or 25:00 roll over and fail this check.
  const utcWall = new Date(guess)
  if (
    utcWall.getUTCFullYear() !== year ||
    utcWall.getUTCMonth() + 1 !== month ||
    utcWall.getUTCDate() !== day ||
    utcWall.getUTCHours() !== hour ||
    utcWall.getUTCMinutes() !== minute ||
    utcWall.getUTCSeconds() !== second
  ) {
    return { status: "invalid" }
  }
  // Offsets a day either side cover any single transition near this time.
  const candidates = new Set<number>()
  for (const probe of [guess - DAY_MS, guess, guess + DAY_MS]) {
    const offset = wallAsUtc(wallTime(probe, timeZone)) - probe
    const instant = guess - offset
    if (sameWall(wallTime(instant, timeZone), wall)) {
      candidates.add(instant)
    }
  }
  const sorted = [...candidates].sort((a, b) => a - b)
  const first = sorted[0]
  if (first === undefined) {
    return { status: "nonexistent" }
  }
  const last = sorted.at(-1) ?? first
  if (last === first) {
    return { status: "ok", iso: new Date(first).toISOString() }
  }
  return {
    status: "ambiguous",
    earlier: new Date(first).toISOString(),
    later: new Date(last).toISOString(),
  }
}
