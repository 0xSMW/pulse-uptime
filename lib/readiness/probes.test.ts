import { describe, expect, it, vi } from "vitest";

import { createEmailProbe } from "./probes";

const env = {
  RESEND_API_KEY: "re_send_only",
  RESEND_FROM_EMAIL: "alerts@example.com",
};

describe("email readiness probe", () => {
  it("verifies a send-only key through an idempotent Resend test delivery", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "email_1" }, error: null });
    const probe = createEmailProbe(env, () => ({
      domains: { list: vi.fn().mockResolvedValue({ data: null, error: { message: "restricted" } }) },
      emails: { send },
    } as never));

    await expect(probe()).resolves.toMatchObject({ state: "ready", code: "EMAIL_READY" });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ from: "alerts@example.com", to: "delivered@resend.dev" }),
      { idempotencyKey: "pulse-readiness-example.com" },
    );
  });

  it("warns when a full-access key reports an unverified sender domain", async () => {
    const send = vi.fn();
    const probe = createEmailProbe(env, () => ({
      domains: { list: vi.fn().mockResolvedValue({
        data: { data: [{ name: "other.example.com", status: "verified" }] },
        error: null,
      }) },
      emails: { send },
    } as never));

    await expect(probe()).resolves.toMatchObject({
      state: "warning",
      code: "EMAIL_DOMAIN_UNVERIFIED",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
