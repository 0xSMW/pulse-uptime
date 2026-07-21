export type CronJobName = "monitor-check" | "maintenance"
export interface CronRunCounts {
  monitorCount: number
  successCount: number
  failureCount: number
  skippedCount: number
}

// Structured, faithful capture of a cron failure. Beyond the short single-line
// message it records the Postgres diagnostic fields (code, detail, constraint,
// table, and the rest) and the wrapped cause chain, so an operator reading
// cron_runs after an incident sees the real fault instead of a lossy summary.
// Bounded at CRON_ERROR_CAPTURE_BYTES with an explicit truncated marker so a
// pathological error can never bloat a run row without saying so.
export interface CronErrorCapture {
  message: string
  name: string
  code?: string
  detail?: string
  hint?: string
  severity?: string
  constraint?: string
  table?: string
  column?: string
  schema?: string
  routine?: string
  stack?: string
  cause?: CronErrorCapture
  truncated?: boolean
}

export interface CronRunFailure {
  message: string
  capture: CronErrorCapture
}

export interface CronRunStore {
  start: (input: {
    id: string
    jobName: CronJobName
    scheduledMinute: Date
    startedAt: Date
    releaseId: string
  }) => Promise<boolean>
  complete: (
    id: string,
    completedAt: Date,
    counts: CronRunCounts
  ) => Promise<void>
  fail: (
    id: string,
    completedAt: Date,
    failure: CronRunFailure,
    counts?: CronRunCounts
  ) => Promise<void>
}

export function emptyRunCounts(): CronRunCounts {
  return { monitorCount: 0, successCount: 0, failureCount: 0, skippedCount: 0 }
}

export function safeCronError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Unknown cron failure"
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500)
}

// The overall JSON of a capture is bounded to this many bytes. A generous cap
// keeps a full stack and a couple of cause levels while refusing to let one
// row grow without limit.
export const CRON_ERROR_CAPTURE_BYTES = 16 * 1024
// Per-string caps applied before the byte bound, so a single huge field cannot
// crowd out the rest of the diagnostic before the size reducer even runs.
const MESSAGE_FIELD_CAP = 4096
const STACK_FIELD_CAP = 8192
const SMALL_FIELD_CAP = 1024
const MAX_CAUSE_DEPTH = 4

function truncatedString(
  value: string,
  cap: number,
  mark: { truncated: boolean }
): string {
  if (value.length <= cap) {
    return value
  }
  mark.truncated = true
  return `${value.slice(0, cap)} [truncated]`
}

function readField(
  source: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (value === undefined || value === null) {
      continue
    }
    const text = typeof value === "string" ? value : String(value)
    if (text.length > 0) {
      return text
    }
  }
}

function buildCapture(
  error: unknown,
  depth: number,
  mark: { truncated: boolean }
): CronErrorCapture {
  if (error instanceof Error) {
    const source = error as unknown as Record<string, unknown>
    const capture: CronErrorCapture = {
      message: truncatedString(
        error.message || error.name || "Error",
        MESSAGE_FIELD_CAP,
        mark
      ),
      name: error.name || "Error",
    }
    const code = readField(source, ["code"])
    const detail = readField(source, ["detail"])
    const hint = readField(source, ["hint"])
    const severity = readField(source, ["severity", "severity_local"])
    const constraint = readField(source, ["constraint_name", "constraint"])
    const table = readField(source, ["table_name", "table"])
    const column = readField(source, ["column_name", "column"])
    const schema = readField(source, ["schema_name", "schema"])
    const routine = readField(source, ["routine"])
    if (code) {
      capture.code = truncatedString(code, SMALL_FIELD_CAP, mark)
    }
    if (detail) {
      capture.detail = truncatedString(detail, MESSAGE_FIELD_CAP, mark)
    }
    if (hint) {
      capture.hint = truncatedString(hint, SMALL_FIELD_CAP, mark)
    }
    if (severity) {
      capture.severity = truncatedString(severity, SMALL_FIELD_CAP, mark)
    }
    if (constraint) {
      capture.constraint = truncatedString(constraint, SMALL_FIELD_CAP, mark)
    }
    if (table) {
      capture.table = truncatedString(table, SMALL_FIELD_CAP, mark)
    }
    if (column) {
      capture.column = truncatedString(column, SMALL_FIELD_CAP, mark)
    }
    if (schema) {
      capture.schema = truncatedString(schema, SMALL_FIELD_CAP, mark)
    }
    if (routine) {
      capture.routine = truncatedString(routine, SMALL_FIELD_CAP, mark)
    }
    if (typeof error.stack === "string" && error.stack.length > 0) {
      capture.stack = truncatedString(error.stack, STACK_FIELD_CAP, mark)
    }
    const cause = source.cause
    if (cause !== undefined && cause !== null) {
      if (depth > 0) {
        capture.cause = buildCapture(cause, depth - 1, mark)
      } else {
        mark.truncated = true
      }
    }
    return capture
  }
  return {
    message: truncatedString(
      typeof error === "string" ? error : String(error),
      MESSAGE_FIELD_CAP,
      mark
    ),
    name: "NonError",
  }
}

function encodedBytes(capture: CronErrorCapture): number {
  return Buffer.byteLength(JSON.stringify(capture))
}

function deepestCause(capture: CronErrorCapture): CronErrorCapture | null {
  let parent: CronErrorCapture | null = null
  let node = capture
  while (node.cause) {
    parent = node
    node = node.cause
  }
  return parent
}

// Sheds the largest, least essential fields first (stacks, then the deepest
// cause) and finally hard-truncates the top message, always leaving a valid
// capture marked truncated. The message and name of the top error are never
// dropped so the row is never useless.
function boundBySize(capture: CronErrorCapture, cap: number): CronErrorCapture {
  if (encodedBytes(capture) <= cap) {
    return capture
  }
  for (
    let node: CronErrorCapture | undefined = capture;
    node;
    node = node.cause
  ) {
    if (node.stack) {
      delete node.stack
      capture.truncated = true
    }
  }
  if (encodedBytes(capture) <= cap) {
    return capture
  }
  while (encodedBytes(capture) > cap) {
    const parent = deepestCause(capture)
    if (!parent) {
      break
    }
    delete parent.cause
    capture.truncated = true
  }
  if (encodedBytes(capture) <= cap) {
    return capture
  }
  const overflow = encodedBytes(capture) - cap
  capture.message = `${capture.message.slice(0, Math.max(0, capture.message.length - overflow - 16))} [truncated]`
  capture.detail = undefined
  capture.truncated = true
  return capture
}

export function captureCronError(error: unknown): CronErrorCapture {
  const mark: { truncated: boolean } = { truncated: false }
  const capture = buildCapture(error, MAX_CAUSE_DEPTH, mark)
  if (mark.truncated) {
    capture.truncated = true
  }
  return boundBySize(capture, CRON_ERROR_CAPTURE_BYTES)
}

export function toCronRunFailure(error: unknown): CronRunFailure {
  try {
    return { message: safeCronError(error), capture: captureCronError(error) }
  } catch {
    // This runs inside the cron catch blocks that call runs.fail, so it must
    // never throw itself. If it did, runs.fail never executes, the cron_runs
    // row stays stuck at running, and the whole invocation rejects. An exotic
    // thrown value (an object with a throwing toString or getter) can defeat
    // safeCronError and captureCronError, so fall back to a fixed minimal
    // capture that reads no field of the offending value.
    const message = "Unrepresentable cron failure"
    return { message, capture: { message, name: "NonError" } }
  }
}
