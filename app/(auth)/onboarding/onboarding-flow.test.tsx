// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TimezoneProvider } from "@/components/dashboard/timezone-provider";

import { OnboardingFlow } from "./onboarding-flow";

function renderAccountStep() {
  return render(
    <TimezoneProvider>
      <OnboardingFlow initialStep="account" />
    </TimezoneProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("onboarding account step", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ nextStep: "monitor" }), { status: 201, headers: { "Content-Type": "application/json" } }),
    );
  });

  it("shows an optional name field above the email field", () => {
    renderAccountStep();
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name).toBeDefined();
    expect(name.required).toBe(false);
    expect(name.maxLength).toBe(120);
    // The name field comes before email in document order.
    const email = screen.getByLabelText("Email");
    expect(name.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("submits the trimmed name with the account payload", async () => {
    renderAccountStep();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Ada Lovelace  " } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("Setup Token"), { target: { value: "setup-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Account" }));

    await waitFor(() => {
      const accountCall = vi.mocked(globalThis.fetch).mock.calls.find(([path]) => path === "/api/onboarding/account");
      expect(accountCall).toBeDefined();
      const body = JSON.parse(String((accountCall![1] as RequestInit).body));
      expect(body.name).toBe("Ada Lovelace");
      expect(body.email).toBe("admin@example.com");
    });
  });

  it("omits the name when the field is left blank", async () => {
    renderAccountStep();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("Setup Token"), { target: { value: "setup-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Account" }));

    await waitFor(() => {
      const accountCall = vi.mocked(globalThis.fetch).mock.calls.find(([path]) => path === "/api/onboarding/account");
      expect(accountCall).toBeDefined();
      const body = JSON.parse(String((accountCall![1] as RequestInit).body));
      expect(body.name).toBeUndefined();
    });
  });
});
