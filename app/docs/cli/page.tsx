import type { Metadata } from "next"
import Link from "next/link"

import { CodeBlock } from "@/components/ui/code-block"

export const metadata: Metadata = {
  title: "pulsectl Documentation",
  description:
    "Install pulsectl and manage Pulse from a terminal or coding agent",
}

const quickStart = `go install github.com/0xSMW/pulse-uptime/cli/cmd/pulsectl@latest
pulsectl me --server https://pulse.superposition.app`

const everydayCommands = `pulsectl status
pulsectl monitor list
pulsectl incident list
pulsectl doctor`

const agentSetup = `export PULSECTL_URL=https://pulse.superposition.app
export PULSECTL_TOKEN=pulse_live_...
export PULSECTL_OUTPUT=json

pulsectl help --output json
pulsectl config schema
pulsectl monitor list`

const configWorkflow = `pulsectl config export --file monitors.yaml
pulsectl config validate --file monitors.yaml
pulsectl config plan --file monitors.yaml
pulsectl config apply --file monitors.yaml`

const reportWorkflow = `pulsectl report create --type incident --title "API outage" \\
  --status investigating --message "We are investigating elevated error rates." \\
  --affected api-prod:down
pulsectl report post rep_123 --status monitoring --message "A fix is deployed; watching recovery."
pulsectl report resolve rep_123`

const reportScripting = `pulsectl incident promote inc_123
pulsectl report publish rep_123

pulsectl report post rep_123 --status identified --message-file - <<'EOF'
The connection pool was exhausted by a runaway deploy.
We are rolling back and restoring capacity.
EOF`

const statusPageWorkflow = `pulsectl status-page set name="Acme Status" historyDays=60
pulsectl status-page export --file status-page.json
pulsectl status-page apply --file status-page.json`

const agentPrompt =
  "Use pulsectl --help to discover commands. Authenticate through PULSECTL_TOKEN, prefer --output json, and never print or persist the token."

export default function CliDocsPage() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-[800px] px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-16 flex items-center justify-between border-[var(--border)] border-b pb-4">
        <Link
          className="rounded-[6px] font-semibold text-[var(--fg)] text-sm tracking-[-0.28px]"
          href="/"
        >
          Pulse
        </Link>
        <Link
          className="rounded-[6px] px-1.5 py-1 font-medium text-[var(--fg-muted)] text-sm hover:bg-[var(--hover)] hover:text-[var(--fg)]"
          href="/settings/access"
        >
          API Tokens <span aria-hidden="true">→</span>
        </Link>
      </header>

      <article>
        <div className="mb-12 max-w-[640px]">
          <p className="mb-3 font-medium font-mono text-[var(--fg-muted)] text-xs uppercase tracking-[0.08em]">
            pulsectl
          </p>
          <h1 className="mb-4 font-semibold text-[32px] text-[var(--fg)] leading-9 tracking-[-1.2px] sm:text-[40px] sm:leading-11">
            Manage Pulse from your terminal
          </h1>
          <p className="text-[var(--fg-muted)] text-base leading-7">
            Use one CLI for monitors, incidents, status, and complete
            configuration. Human sessions link through the browser; agents use
            scoped tokens.
          </p>
        </div>

        <section aria-labelledby="quick-start" className="mb-12">
          <SectionHeading
            description="Install pulsectl, then link this server to your device"
            eyebrow="01"
            id="quick-start"
            title="Install and link"
          />
          <CodeBlock
            code={quickStart}
            copyLabel="Copy install commands"
            language="shell"
          />
          <p className="mt-3 text-[13px] text-[var(--fg-muted)] leading-5">
            Replace the example URL with your Pulse deployment. The command
            opens a browser for approval and stores the session in your
            operating-system keyring.
          </p>
        </section>

        <section aria-labelledby="daily-use" className="mb-12">
          <SectionHeading
            description="Start with status, monitors, incidents, and diagnostics"
            eyebrow="02"
            id="daily-use"
            title="Run everyday checks"
          />
          <CodeBlock
            code={everydayCommands}
            copyLabel="Copy common commands"
            language="shell"
          />
          <p className="mt-3 text-[13px] text-[var(--fg-muted)] leading-5">
            Run{" "}
            <code className="font-mono text-[var(--fg)]">pulsectl --help</code>{" "}
            for the complete command inventory and examples.
          </p>
        </section>

        <section aria-labelledby="agents" className="mb-12">
          <SectionHeading
            description="Create a scoped token in Settings → API Tokens"
            eyebrow="03"
            id="agents"
            title="Connect an agent"
          />
          <CodeBlock
            code={agentSetup}
            copyLabel="Copy agent setup"
            language="shell"
          />
          <div className="mt-4 rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg)] p-5 shadow-[var(--card-shadow)] sm:p-6">
            <h3 className="mb-2 font-semibold text-[var(--fg)] text-sm tracking-[-0.28px]">
              Agent prompt
            </h3>
            <p className="mb-4 text-[13px] text-[var(--fg-muted)] leading-5">
              Give your agent these operating rules
            </p>
            <CodeBlock code={agentPrompt} copyLabel="Copy agent prompt" />
          </div>
          <p className="mt-3 text-[13px] text-[var(--fg-muted)] leading-5">
            Keep secrets in the environment or stdin. pulsectl has no global
            token flag, so tokens stay out of shell history and process
            listings.
          </p>
        </section>

        <section aria-labelledby="configuration" className="mb-12">
          <SectionHeading
            description="Export, validate, review the plan, then apply"
            eyebrow="04"
            id="configuration"
            title="Apply configuration safely"
          />
          <CodeBlock
            code={configWorkflow}
            copyLabel="Copy config workflow"
            language="shell"
          />
          <p className="mt-3 text-[13px] text-[var(--fg-muted)] leading-5">
            Noninteractive destructive applies require both
            <code className="mx-1 font-mono text-[var(--fg)]">
              --allow-destructive
            </code>
            and <code className="font-mono text-[var(--fg)]">--yes</code>.
          </p>
        </section>

        <section aria-labelledby="status-reports" className="mb-16">
          <SectionHeading
            description="Author incident and maintenance timelines on your status page"
            eyebrow="05"
            id="status-reports"
            title="Publish status reports"
          />
          <CodeBlock
            code={reportWorkflow}
            copyLabel="Copy report workflow"
            language="shell"
          />
          <p className="mt-3 mb-4 text-[13px] text-[var(--fg-muted)] leading-5">
            <code className="font-mono text-[var(--fg)]">report resolve</code>{" "}
            posts the closing update — &ldquo;Resolved.&rdquo; for incidents,
            &ldquo;Completed.&rdquo; for maintenance — unless you pass{" "}
            <code className="font-mono text-[var(--fg)]">--message</code>.
            Promote a detected incident into a draft report, publish it, and
            pipe longer updates through stdin:
          </p>
          <CodeBlock
            code={reportScripting}
            copyLabel="Copy scripting example"
            language="shell"
          />
          <p className="mt-3 mb-4 text-[13px] text-[var(--fg-muted)] leading-5">
            The status page itself — name, branding, links, announcement,
            history math — is edited the same way as monitors: export, edit,
            apply. Exports embed the current ETag, so a stale apply fails
            instead of overwriting concurrent edits.
          </p>
          <CodeBlock
            code={statusPageWorkflow}
            copyLabel="Copy status page workflow"
            language="shell"
          />
          <p className="mt-3 text-[13px] text-[var(--fg-muted)] leading-5">
            Report commands require the
            <code className="mx-1 font-mono text-[var(--fg)]">
              reports:read
            </code>
            and{" "}
            <code className="font-mono text-[var(--fg)]">reports:write</code>{" "}
            scopes. Tokens minted before these scopes existed lack them — re-run{" "}
            <code className="font-mono text-[var(--fg)]">
              pulsectl auth login
            </code>{" "}
            or create a new token.
          </p>
        </section>
      </article>

      <footer className="flex flex-col gap-3 border-[var(--border)] border-t pt-6 text-[13px] text-[var(--fg-muted)] sm:flex-row sm:items-center sm:justify-between">
        <span>Data on stdout · diagnostics on stderr</span>
        <Link
          className="w-fit rounded-[6px] font-medium text-[var(--fg)] transition-opacity duration-150 hover:opacity-70"
          href="/settings/access"
        >
          Create an API token →
        </Link>
      </footer>
    </main>
  )
}

function SectionHeading({
  id,
  eyebrow,
  title,
  description,
}: {
  id: string
  eyebrow: string
  title: string
  description: string
}) {
  return (
    <div className="mb-4 grid gap-1 sm:grid-cols-[40px_1fr] sm:gap-x-3">
      <span
        aria-hidden="true"
        className="font-mono text-[var(--fg-faint)] text-xs leading-6"
      >
        {eyebrow}
      </span>
      <div>
        <h2
          className="font-semibold text-[var(--fg)] text-xl leading-7 tracking-[-0.4px]"
          id={id}
        >
          {title}
        </h2>
        <p className="mt-1 text-[var(--fg-muted)] text-sm leading-5">
          {description}
        </p>
      </div>
    </div>
  )
}
