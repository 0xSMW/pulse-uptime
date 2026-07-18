import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/ui/code-block";

export const metadata: Metadata = {
  title: "pulsectl Documentation",
  description: "Install pulsectl and manage Pulse from a terminal or coding agent",
};

const quickStart = `go install github.com/0xSMW/pulse-uptime/cli/cmd/pulsectl@latest
pulsectl me --server https://pulse.example.com`;

const everydayCommands = `pulsectl status
pulsectl monitor list
pulsectl incident list
pulsectl doctor`;

const agentSetup = `export PULSECTL_URL=https://pulse.example.com
export PULSECTL_TOKEN=pulse_live_...
export PULSECTL_OUTPUT=json

pulsectl help --output json
pulsectl config schema
pulsectl monitor list`;

const configWorkflow = `pulsectl config export --file monitors.yaml
pulsectl config validate --file monitors.yaml
pulsectl config plan --file monitors.yaml
pulsectl config apply --file monitors.yaml`;

const agentPrompt =
  "Use pulsectl --help to discover commands. Authenticate through PULSECTL_TOKEN, prefer --output json, and never print or persist the token.";

export default function CliDocsPage() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-[800px] px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-16 flex items-center justify-between border-b border-[var(--border)] pb-4">
        <Link
          href="/"
          className="rounded-[6px] text-sm font-semibold tracking-[-0.28px] text-[var(--fg)]"
        >
          Pulse
        </Link>
        <Link
          href="/settings/access"
          className="rounded-[6px] px-1.5 py-1 text-sm font-medium text-[var(--fg-muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
        >
          API Tokens <span aria-hidden="true">→</span>
        </Link>
      </header>

      <article>
        <div className="mb-12 max-w-[640px]">
          <p className="mb-3 font-mono text-xs font-medium tracking-[0.08em] text-[var(--fg-muted)] uppercase">
            pulsectl
          </p>
          <h1 className="mb-4 text-[32px] leading-9 font-semibold tracking-[-1.2px] text-[var(--fg)] sm:text-[40px] sm:leading-11">
            Manage Pulse from your terminal
          </h1>
          <p className="text-base leading-7 text-[var(--fg-muted)]">
            Use one CLI for monitors, incidents, status, and complete configuration. Human
            sessions link through the browser; agents use scoped tokens.
          </p>
        </div>

        <section className="mb-12" aria-labelledby="quick-start">
          <SectionHeading
            id="quick-start"
            eyebrow="01"
            title="Install and link"
            description="Install pulsectl, then link this server to your device"
          />
          <CodeBlock code={quickStart} language="shell" copyLabel="Copy install commands" />
          <p className="mt-3 text-[13px] leading-5 text-[var(--fg-muted)]">
            Replace the example URL with your Pulse deployment. The command opens a browser for
            approval and stores the session in your operating-system keyring.
          </p>
        </section>

        <section className="mb-12" aria-labelledby="daily-use">
          <SectionHeading
            id="daily-use"
            eyebrow="02"
            title="Run everyday checks"
            description="Start with status, monitors, incidents, and diagnostics"
          />
          <CodeBlock code={everydayCommands} language="shell" copyLabel="Copy common commands" />
          <p className="mt-3 text-[13px] leading-5 text-[var(--fg-muted)]">
            Run <code className="font-mono text-[var(--fg)]">pulsectl --help</code> for the complete
            command inventory and examples.
          </p>
        </section>

        <section className="mb-12" aria-labelledby="agents">
          <SectionHeading
            id="agents"
            eyebrow="03"
            title="Connect an agent"
            description="Create a scoped token in Settings → API Tokens"
          />
          <CodeBlock code={agentSetup} language="shell" copyLabel="Copy agent setup" />
          <div className="mt-4 rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg)] p-5 shadow-[var(--card-shadow)] sm:p-6">
            <h3 className="mb-2 text-sm font-semibold tracking-[-0.28px] text-[var(--fg)]">
              Agent prompt
            </h3>
            <p className="mb-4 text-[13px] leading-5 text-[var(--fg-muted)]">
              Give your agent these operating rules
            </p>
            <CodeBlock code={agentPrompt} copyLabel="Copy agent prompt" />
          </div>
          <p className="mt-3 text-[13px] leading-5 text-[var(--fg-muted)]">
            Keep secrets in the environment or stdin. pulsectl has no global token flag, so tokens
            stay out of shell history and process listings.
          </p>
        </section>

        <section className="mb-16" aria-labelledby="configuration">
          <SectionHeading
            id="configuration"
            eyebrow="04"
            title="Apply configuration safely"
            description="Export, validate, review the plan, then apply"
          />
          <CodeBlock code={configWorkflow} language="shell" copyLabel="Copy config workflow" />
          <p className="mt-3 text-[13px] leading-5 text-[var(--fg-muted)]">
            Noninteractive destructive applies require both
            <code className="mx-1 font-mono text-[var(--fg)]">--allow-delete</code>
            and <code className="font-mono text-[var(--fg)]">--yes</code>.
          </p>
        </section>
      </article>

      <footer className="flex flex-col gap-3 border-t border-[var(--border)] pt-6 text-[13px] text-[var(--fg-muted)] sm:flex-row sm:items-center sm:justify-between">
        <span>Data on stdout · diagnostics on stderr</span>
        <Link
          href="/settings/access"
          className="w-fit rounded-[6px] font-medium text-[var(--fg)] hover:underline"
        >
          Create an API token →
        </Link>
      </footer>
    </main>
  );
}

function SectionHeading({
  id,
  eyebrow,
  title,
  description,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-4 grid gap-1 sm:grid-cols-[40px_1fr] sm:gap-x-3">
      <span className="font-mono text-xs leading-6 text-[var(--fg-faint)]" aria-hidden="true">
        {eyebrow}
      </span>
      <div>
        <h2 id={id} className="text-xl leading-7 font-semibold tracking-[-0.4px] text-[var(--fg)]">
          {title}
        </h2>
        <p className="mt-1 text-sm leading-5 text-[var(--fg-muted)]">{description}</p>
      </div>
    </div>
  );
}
