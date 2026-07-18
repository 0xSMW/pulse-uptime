import { describe, expect, it } from "vitest";

import { createResendSender, NotificationProviderError } from "./provider";

describe("Resend notification provider", () => {
  it("allows monitoring to start when email is intentionally unconfigured", async () => {
    const sender = createResendSender({ apiKey: "", from: "" });

    await expect(sender.send({
      to: "ops@example.com",
      subject: "Outage",
      react: "Outage",
    }, "notification-1")).rejects.toEqual(
      expect.objectContaining<Partial<NotificationProviderError>>({
        code: "email_not_configured",
        retryable: false,
      }),
    );
  });
});
