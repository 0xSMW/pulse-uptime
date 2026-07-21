import { Resend } from "resend"
import type { NotificationMessage } from "./message"

interface NotificationSendResult {
  providerMessageId: string
}

export interface NotificationSender {
  send: (
    message: NotificationMessage,
    idempotencyKey: string
  ) => Promise<NotificationSendResult>
}

export class NotificationProviderError extends Error {
  readonly retryable: boolean

  constructor(
    readonly code: string,
    options: { retryable: boolean }
  ) {
    super(code)
    this.name = "NotificationProviderError"
    this.retryable = options.retryable
  }
}

const RETRYABLE_CODES = new Set([
  "application_error",
  "concurrent_idempotent_requests",
  "daily_quota_exceeded",
  "internal_server_error",
  "monthly_quota_exceeded",
  "rate_limit_exceeded",
])

export function createResendSender(options: {
  apiKey: string
  from: string
}): NotificationSender {
  if (!(options.apiKey && options.from)) {
    return {
      async send() {
        throw new NotificationProviderError("email_not_configured", {
          retryable: false,
        })
      },
    }
  }
  const resend = new Resend(options.apiKey)
  return {
    async send(message, idempotencyKey) {
      const response = await resend.emails.send(
        { ...message, from: options.from },
        { idempotencyKey }
      )
      if (response.error) {
        throw new NotificationProviderError(response.error.name, {
          retryable:
            RETRYABLE_CODES.has(response.error.name) ||
            response.error.statusCode === 408 ||
            response.error.statusCode === 429 ||
            (response.error.statusCode !== null &&
              response.error.statusCode >= 500),
        })
      }
      return { providerMessageId: response.data.id }
    },
  }
}
