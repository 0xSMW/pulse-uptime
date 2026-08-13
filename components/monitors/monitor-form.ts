import { parseMonitorRecipients } from "@/lib/monitoring/recipients"
import { isPublicHttpUrl } from "@/lib/net/public-url"

export interface EditableMonitor {
  id: string
  name: string
  url: string
  enabled: boolean
  groupId: string | null
  group: string | null
  method: string
  intervalMinutes: number
  timeoutMs: number
  expectedStatusMin: number
  expectedStatusMax: number
  failureThreshold: number
  recoveryThreshold: number
  recipients: string[]
}

interface CommonMonitorFormValues<NumericValue extends number | string> {
  name: string
  url: string
  enabled: boolean
  groupId: string | null
  method: string
  intervalMinutes: NumericValue
  timeoutMs: NumericValue
  expectedStatusMin: NumericValue
  expectedStatusMax: NumericValue
  failureThreshold: NumericValue
  recoveryThreshold: NumericValue
  recipientsText: string
}

export type NumericMonitorFormValues = CommonMonitorFormValues<number>
export type StringMonitorFormValues = CommonMonitorFormValues<string> & {
  method: "GET" | "HEAD"
}

export type MonitorFormErrorKey = keyof CommonMonitorFormValues<number>
export type MonitorFormErrors = Partial<Record<MonitorFormErrorKey, string>>

interface MonitorValidationCopy {
  timeout: string
  status: string
  statusMaximum: string
  threshold: string
  recipientLimit: string
}

interface MonitorValidationOptions {
  copy: MonitorValidationCopy
  compareStatusOnlyWhenBothValid: boolean
  validateInterval: boolean
}

const advancedMonitorFields = [
  "timeoutMs",
  "expectedStatusMin",
  "expectedStatusMax",
  "failureThreshold",
  "recoveryThreshold",
  "recipientsText",
] as const

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const numericMonitorValidation: MonitorValidationOptions = {
  copy: {
    timeout: "Enter 1000–15000",
    status: "Enter 100–599",
    statusMaximum: "Enter a value from minimum to 599",
    threshold: "Enter 1–5",
    recipientLimit: "Use no more than 20 addresses",
  },
  compareStatusOnlyWhenBothValid: false,
  validateInterval: false,
}

export const stringMonitorValidation: MonitorValidationOptions = {
  copy: {
    timeout: "Use 1000–15000 ms",
    status: "Use a status from 100–599",
    statusMaximum: "Maximum must be at least the minimum",
    threshold: "Use a threshold from 1–5",
    recipientLimit: "Use no more than 20 recipients",
  },
  compareStatusOnlyWhenBothValid: true,
  validateInterval: true,
}

export const emptyNumericMonitorValues: NumericMonitorFormValues = {
  name: "",
  url: "",
  groupId: null,
  method: "GET",
  intervalMinutes: 1,
  timeoutMs: 8000,
  expectedStatusMin: 200,
  expectedStatusMax: 399,
  failureThreshold: 2,
  recoveryThreshold: 2,
  recipientsText: "",
  enabled: true,
}

export function numericMonitorValues(
  monitor: EditableMonitor
): NumericMonitorFormValues {
  return {
    name: monitor.name,
    url: monitor.url,
    enabled: monitor.enabled,
    groupId: monitor.groupId,
    method: monitor.method,
    intervalMinutes: monitor.intervalMinutes,
    timeoutMs: monitor.timeoutMs,
    expectedStatusMin: monitor.expectedStatusMin,
    expectedStatusMax: monitor.expectedStatusMax,
    failureThreshold: monitor.failureThreshold,
    recoveryThreshold: monitor.recoveryThreshold,
    recipientsText: monitor.recipients.join("\n"),
  }
}

export function stringMonitorValues(
  monitor: EditableMonitor
): StringMonitorFormValues {
  return {
    name: monitor.name,
    url: monitor.url,
    groupId: monitor.groupId,
    method: monitor.method === "HEAD" ? "HEAD" : "GET",
    intervalMinutes: String(monitor.intervalMinutes),
    timeoutMs: String(monitor.timeoutMs),
    expectedStatusMin: String(monitor.expectedStatusMin),
    expectedStatusMax: String(monitor.expectedStatusMax),
    failureThreshold: String(monitor.failureThreshold),
    recoveryThreshold: String(monitor.recoveryThreshold),
    recipientsText: monitor.recipients.join("\n"),
    enabled: monitor.enabled,
  }
}

export function isPublicMonitorUrl(value: string): boolean {
  return isPublicHttpUrl(value)
}

export function deriveMonitorName(url: string): string {
  for (const candidate of [url.trim(), `https://${url.trim()}`]) {
    try {
      const hostname = new URL(candidate).hostname.replace(/^www\./, "")
      if (hostname) {
        return hostname
      }
    } catch {
      // Try the candidate with an assumed scheme.
    }
  }
  return ""
}

export function validateMonitorValues(
  values: CommonMonitorFormValues<number | string>,
  options: MonitorValidationOptions
): MonitorFormErrors {
  const errors: MonitorFormErrors = {}
  const name = values.name.trim()
  if (!name) {
    errors.name = "Enter a monitor name"
  } else if (name.length > 80) {
    errors.name = "Use 80 characters or fewer"
  }
  if (!isPublicMonitorUrl(values.url)) {
    errors.url = "Enter a public HTTP or HTTPS URL"
  }
  if (
    options.validateInterval &&
    !["1", "5", "10", "15"].includes(String(values.intervalMinutes))
  ) {
    errors.intervalMinutes = "Choose 1, 5, 10, or 15 minutes"
  }

  validateInteger(
    values.timeoutMs,
    1000,
    15_000,
    options.copy.timeout,
    "timeoutMs",
    errors
  )
  validateInteger(
    values.expectedStatusMin,
    100,
    599,
    options.copy.status,
    "expectedStatusMin",
    errors
  )
  if (options.compareStatusOnlyWhenBothValid) {
    validateInteger(
      values.expectedStatusMax,
      100,
      599,
      options.copy.status,
      "expectedStatusMax",
      errors
    )
    if (
      !(errors.expectedStatusMin || errors.expectedStatusMax) &&
      Number(values.expectedStatusMax) < Number(values.expectedStatusMin)
    ) {
      errors.expectedStatusMax = options.copy.statusMaximum
    }
  } else {
    validateInteger(
      values.expectedStatusMax,
      Number(values.expectedStatusMin),
      599,
      options.copy.statusMaximum,
      "expectedStatusMax",
      errors
    )
  }
  validateInteger(
    values.failureThreshold,
    1,
    5,
    options.copy.threshold,
    "failureThreshold",
    errors
  )
  validateInteger(
    values.recoveryThreshold,
    1,
    5,
    options.copy.threshold,
    "recoveryThreshold",
    errors
  )

  const recipients = parseMonitorRecipients(values.recipientsText)
  if (recipients.length > 20) {
    errors.recipientsText = options.copy.recipientLimit
  } else if (recipients.some((recipient) => !emailPattern.test(recipient))) {
    errors.recipientsText = "Enter valid email addresses"
  } else if (
    new Set(recipients.map((recipient) => recipient.toLowerCase())).size !==
    recipients.length
  ) {
    errors.recipientsText = "Remove duplicate recipients"
  }
  return errors
}

function validateInteger(
  value: number | string,
  minimum: number,
  maximum: number,
  message: string,
  field: MonitorFormErrorKey,
  errors: MonitorFormErrors
) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    errors[field] = message
  }
}

export function hasAdvancedMonitorErrors(errors: MonitorFormErrors): boolean {
  return advancedMonitorFields.some((field) => Boolean(errors[field]))
}

export interface MonitorMutationBody {
  name: string
  url: string
  enabled: boolean
  groupId: string | null
  method: string
  intervalMinutes: number
  timeoutMs: number
  expectedStatus: { minimum: number; maximum: number }
  failureThreshold: number
  recoveryThreshold: number
  recipients: string[]
}

export function monitorMutationBody(
  values: CommonMonitorFormValues<number | string>,
  options: { trimUrl: boolean }
): MonitorMutationBody {
  return {
    name: values.name.trim(),
    url: options.trimUrl ? values.url.trim() : values.url,
    enabled: values.enabled,
    groupId: values.groupId,
    method: values.method,
    intervalMinutes: Number(values.intervalMinutes),
    timeoutMs: Number(values.timeoutMs),
    expectedStatus: {
      minimum: Number(values.expectedStatusMin),
      maximum: Number(values.expectedStatusMax),
    },
    failureThreshold: Number(values.failureThreshold),
    recoveryThreshold: Number(values.recoveryThreshold),
    recipients: parseMonitorRecipients(values.recipientsText),
  }
}
