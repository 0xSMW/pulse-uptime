"use client";

import { User } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { AppearancePicker } from "@/components/settings/appearance-picker";
import { initialsFor } from "@/lib/account/initials";
import { useDirtyGuard } from "@/components/settings/settings-dirty";
import { CardHeading, SettingsRow } from "@/components/settings/settings-row";
import { StatusMessage, type Message } from "@/components/settings/status-message";
import { TimezoneControl } from "@/components/settings/timezone-control";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export type AccountSettingsData = {
  name: string | null;
  email: string;
  timezone: string | null;
  avatarImageId: string | null;
};

type ApiErrorEnvelope = { error?: { message?: string } };

async function requestJson(path: string, init: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiErrorEnvelope;
    throw new Error(payload.error?.message || "Request failed. Try again.");
  }
  return response.json();
}

// Client mirror of the server caps in lib/api/images.ts (MAX_IMAGE_BYTES).
const MAX_AVATAR_BYTES = 512 * 1024;
const AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

export function avatarValidationError(file: File): string {
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!AVATAR_MIME_TYPES.includes(type)) return "Use a PNG, JPEG, or WebP image.";
  if (file.size > MAX_AVATAR_BYTES) return "Avatar images must be at most 512 KB.";
  return "";
}

export { initialsFor };

export function AccountSettings({ data }: { data: AccountSettingsData }) {
  const router = useRouter();

  const savedName = data.name ?? "";
  const [nameText, setNameText] = useState(savedName);
  const [nameBusy, setNameBusy] = useState(false);

  const [emailFormOpen, setEmailFormOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState("");

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);

  // One status region for the whole Profile card.
  const [profileMessage, setProfileMessage] = useState<Message | null>(null);

  const nameDirty = nameText.trim() !== savedName;
  const nameError = nameText.trim().length > 120 ? "Use no more than 120 characters" : "";
  const emailDirty = emailFormOpen && Boolean(newEmail || confirmEmail || currentPassword);
  const emailMismatch = Boolean(newEmail) && Boolean(confirmEmail)
    && newEmail.trim().toLowerCase() !== confirmEmail.trim().toLowerCase();

  useDirtyGuard("account-profile", nameDirty || emailDirty);

  async function saveName() {
    if (!nameDirty || nameError || !nameText.trim()) return;
    setNameBusy(true);
    setProfileMessage(null);
    try {
      await requestJson("/api/v1/me", { method: "PATCH", body: JSON.stringify({ name: nameText.trim() }) });
      setProfileMessage({ text: "Name saved", tone: "info" });
      router.refresh();
    } catch (error) {
      setProfileMessage({ text: error instanceof Error ? error.message : "Request failed. Try again.", tone: "error" });
    } finally {
      setNameBusy(false);
    }
  }

  function closeEmailForm() {
    setEmailFormOpen(false);
    setNewEmail("");
    setConfirmEmail("");
    setCurrentPassword("");
    setEmailError("");
  }

  async function changeEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailError("");
    setProfileMessage(null);
    if (emailMismatch) {
      setEmailError("Email addresses do not match");
      return;
    }
    setEmailBusy(true);
    try {
      const payload = (await requestJson("/api/v1/me/email", {
        method: "POST",
        body: JSON.stringify({ email: newEmail, emailConfirm: confirmEmail, currentPassword }),
      })) as { data?: { email?: string } };
      const committed = payload.data?.email ?? newEmail.trim().toLowerCase();
      setProfileMessage({ text: `Email updated. You will now sign in as ${committed}.`, tone: "info" });
      closeEmailForm();
      router.refresh();
    } catch (error) {
      setEmailError(error instanceof Error ? error.message : "Request failed. Try again.");
    } finally {
      setEmailBusy(false);
    }
  }

  async function uploadAvatar(file: File) {
    // Mirrors the server allowlist and the 512 KB cap in lib/api/images.ts.
    const preflightError = avatarValidationError(file);
    if (preflightError) {
      setProfileMessage({ text: preflightError, tone: "error" });
      if (avatarInputRef.current) avatarInputRef.current.value = "";
      return;
    }
    setAvatarBusy(true);
    setProfileMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", "avatar");
      const uploadResponse = await fetch("/api/v1/images", { method: "POST", body: form });
      if (!uploadResponse.ok) {
        const payload = (await uploadResponse.json().catch(() => ({}))) as ApiErrorEnvelope;
        throw new Error(payload.error?.message || "Upload failed. Try again.");
      }
      const uploaded = (await uploadResponse.json()) as { data?: { id?: string } };
      if (!uploaded.data?.id) throw new Error("Upload failed. Try again.");
      await requestJson("/api/v1/me", {
        method: "PATCH",
        body: JSON.stringify({ avatarImageId: uploaded.data.id }),
      });
      setProfileMessage({ text: "Avatar updated", tone: "info" });
      router.refresh();
    } catch (error) {
      setProfileMessage({ text: error instanceof Error ? error.message : "Upload failed. Try again.", tone: "error" });
    } finally {
      setAvatarBusy(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  }

  // Initials stand in for the avatar only when a name is set, matching the user
  // menu. Without one the frame keeps the neutral User glyph.
  const initials = data.name?.trim() ? initialsFor(data.name, data.email) : "";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeading title="Profile" />
        <CardContent className="pt-0">
          <div className="max-w-[640px] space-y-5">
            <div className="flex items-center gap-4">
              <span
                aria-hidden
                className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--border-strong)] bg-[var(--chip-bg)] text-[15px] font-medium text-[var(--fg-muted)]"
              >
                {data.avatarImageId ? (
                  // eslint-disable-next-line @next/next/no-img-element -- authenticated dynamic bytes, not an optimizable static asset
                  <img src={`/api/v1/images/${data.avatarImageId}`} alt="" className="size-full object-cover" />
                ) : (
                  initials || <User className="size-5" aria-hidden />
                )}
              </span>
              <div>
                <p className="text-[13px] font-medium">Avatar</p>
                <p className="mt-0.5 text-[13px] text-[var(--fg-muted)]">PNG, JPEG, or WebP up to 512 KB.</p>
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                aria-label="Upload avatar"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadAvatar(file);
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="ml-auto"
                disabled={avatarBusy}
                onClick={() => avatarInputRef.current?.click()}
              >
                {avatarBusy ? "Uploading…" : "Upload Avatar"}
              </Button>
            </div>

            <form
              onSubmit={(event) => { event.preventDefault(); void saveName(); }}
              className="space-y-3"
            >
              <Field
                label="Name"
                htmlFor="account-name"
                description="Shown in the user menu."
                error={nameError || undefined}
              >
                <div className="flex gap-2">
                  <Input
                    id="account-name"
                    value={nameText}
                    onChange={(event) => setNameText(event.target.value)}
                    maxLength={160}
                    placeholder="Your name"
                    className="max-w-[320px]"
                    inputSize="sm"
                  />
                  <Button type="submit" variant="secondary" size="sm" disabled={nameBusy || !nameDirty || !nameText.trim() || Boolean(nameError)}>
                    {nameBusy ? "Saving…" : "Save Name"}
                  </Button>
                </div>
              </Field>
            </form>
          </div>

          <div className="-mx-6 mt-5 border-t border-[var(--border)] px-6 pt-4">
            <div className="max-w-[640px]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[13px] font-medium">Email</p>
                  <p className="mt-0.5 font-data text-[13px] text-[var(--fg-muted)]">{data.email}</p>
                </div>
                {!emailFormOpen ? (
                  <Button variant="secondary" size="sm" onClick={() => setEmailFormOpen(true)}>
                    Change Email
                  </Button>
                ) : null}
              </div>
              {emailFormOpen ? (
                <form onSubmit={changeEmail} className="mt-4 space-y-3">
                  <p className="text-[13px] text-[var(--fg-muted)]">
                    Your email is how you sign in. Confirm it twice and enter your current password to change it.
                  </p>
                  <Field label="New email" htmlFor="account-new-email">
                    <Input
                      id="account-new-email"
                      type="email"
                      value={newEmail}
                      onChange={(event) => setNewEmail(event.target.value)}
                      autoComplete="email"
                      required
                      className="max-w-[320px]"
                      inputSize="sm"
                    />
                  </Field>
                  <Field
                    label="Confirm new email"
                    htmlFor="account-confirm-email"
                    error={emailMismatch ? "Email addresses do not match" : undefined}
                  >
                    <Input
                      id="account-confirm-email"
                      type="email"
                      value={confirmEmail}
                      onChange={(event) => setConfirmEmail(event.target.value)}
                      aria-invalid={emailMismatch || undefined}
                      autoComplete="email"
                      required
                      className="max-w-[320px]"
                      inputSize="sm"
                    />
                  </Field>
                  <Field label="Current password" htmlFor="account-current-password">
                    <Input
                      id="account-current-password"
                      type="password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                      autoComplete="current-password"
                      required
                      className="max-w-[320px]"
                      inputSize="sm"
                    />
                  </Field>
                  {emailError ? (
                    <p role="alert" className="text-[13px] text-[var(--down-text)]">{emailError}</p>
                  ) : null}
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={emailBusy || emailMismatch || !newEmail || !confirmEmail || !currentPassword}>
                      {emailBusy ? "Changing…" : "Change Email"}
                    </Button>
                    <Button type="button" variant="secondary" size="sm" onClick={closeEmailForm} disabled={emailBusy}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : null}
            </div>
          </div>

          <div className="mt-5 max-w-[640px]">
            <StatusMessage message={profileMessage} />
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeading title="Preferences" />
        <div className="border-t border-[var(--border)]">
          <SettingsRow label="Theme" description="How the dashboard looks on this device only. Also available from the account menu.">
            <AppearancePicker />
          </SettingsRow>
          <SettingsRow label="Time zone" description="Saved to your account and used everywhere you sign in.">
            <TimezoneControl />
          </SettingsRow>
        </div>
      </Card>
    </div>
  );
}
