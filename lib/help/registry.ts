export type HelpDemoKey =
  | "monitor-row"
  | "monitor-states"
  | "check-settings"
  | "timeline"
  | "incident"
  | "alerts"
  | "status-page"
  | "tokens"
  | "database-health"
  | "test-monitor"
  | "pause-toggle"
  | "email-test"
  | "cli-link"
  | "agent-connect";

export type HelpEntry = {
  kind: "concept" | "guide";
  slug: string;
  title: string;
  summary: string;
  steps?: string[];
  demo: HelpDemoKey;
  relatedLinks: Array<{ label: string; href: string }>;
};

export function helpEntryId(entry: Pick<HelpEntry, "kind" | "slug">): string {
  return `${entry.kind}-${entry.slug}`;
}

const concepts: HelpEntry[] = [
  {
    kind: "concept",
    slug: "monitors",
    title: "Monitors",
    summary:
      "A monitor checks one HTTP or HTTPS endpoint on a fixed interval. Each check records reachability, status code, and latency, and those results drive the monitor's state, uptime, and incident history. Create and edit monitors in Settings; the Overview table shows every monitor's current state at a glance.",
    demo: "monitor-row",
    relatedLinks: [
      { label: "Monitors in Settings", href: "/settings/monitors" },
      { label: "Overview", href: "/" },
      { label: "Create a monitor", href: "#guide-create-monitor" },
    ],
  },
  {
    kind: "concept",
    slug: "monitor-states",
    title: "Monitor states",
    summary:
      "Every monitor is in exactly one state. Pending means no completed checks yet. Up means the endpoint is passing checks. Verifying means a change is being confirmed before the state flips. Down means consecutive failures reached the failure threshold. Paused means checks are suspended and no alerts are sent.",
    demo: "monitor-states",
    relatedLinks: [
      { label: "Checks and thresholds", href: "#concept-checks-and-thresholds" },
      { label: "Pause or resume monitoring", href: "#guide-pause-monitor" },
    ],
  },
  {
    kind: "concept",
    slug: "checks-and-thresholds",
    title: "Checks and thresholds",
    summary:
      "Each check requests the monitor's URL with its configured method and timeout. A response outside the expected status range, or no response at all, counts as a failure. The failure threshold sets how many consecutive failures confirm an outage; the recovery threshold sets how many consecutive successes confirm recovery.",
    demo: "check-settings",
    relatedLinks: [
      { label: "Edit check settings", href: "#guide-edit-check-settings" },
      { label: "Monitors in Settings", href: "/settings/monitors" },
    ],
  },
  {
    kind: "concept",
    slug: "uptime-and-unknown",
    title: "Uptime and Unknown time",
    summary:
      "Uptime is the share of scheduled checks that succeeded in a window. When a scheduled check never ran — during a deploy or a scheduler gap — that period counts as Unknown rather than up or down, so missing data never inflates uptime. Timelines shade Unknown periods separately from success and failure.",
    demo: "timeline",
    relatedLinks: [
      { label: "Overview", href: "/" },
      { label: "Public status page", href: "#concept-status-page" },
    ],
  },
  {
    kind: "concept",
    slug: "incidents",
    title: "Incidents and recovery",
    summary:
      "An incident opens when failures reach the failure threshold and stays ongoing until successes reach the recovery threshold. Its event trail records each step: first failure, confirmation, alert emails, first success, and confirmed recovery. Resolved incidents keep their duration and opening failure in history.",
    demo: "incident",
    relatedLinks: [
      { label: "Incidents", href: "/incidents" },
      { label: "Investigate an incident", href: "#guide-investigate-incident" },
    ],
  },
  {
    kind: "concept",
    slug: "alerts",
    title: "Alerts and recipients",
    summary:
      "Pulse sends an email when an outage is confirmed and again when recovery is confirmed. Each monitor can list its own recipients; monitors without any use the default recipients in Settings. Delivery state — sent, retrying, or dead — appears beside every incident.",
    demo: "alerts",
    relatedLinks: [
      { label: "Notifications in Settings", href: "/settings/notifications" },
      { label: "Configure alert recipients", href: "#guide-configure-alerts" },
      { label: "Test email delivery", href: "#guide-test-email" },
    ],
  },
  {
    kind: "concept",
    slug: "status-page",
    title: "Public status page",
    summary:
      "The status page shares live availability without requiring sign-in. It shows an overall banner, each monitor's state, and recent timelines, and it follows each visitor's device theme — unless you force a theme in Settings → Status page — rather than your dashboard appearance. Share its address with anyone who needs to know whether service is up.",
    demo: "status-page",
    relatedLinks: [
      { label: "Status page", href: "/status" },
      { label: "Share the status page", href: "#guide-share-status-page" },
    ],
  },
  {
    kind: "concept",
    slug: "report-drafts",
    title: "Publish vs draft reports",
    summary:
      "A status report starts as a draft unless you publish it right away. Drafts are invisible on the public status page and its API, so you can shape the narrative before anyone sees it. Publishing is one-way: a live report gains updates rather than disappearing. Reports promoted from outages always begin as drafts.",
    demo: "status-page",
    relatedLinks: [
      { label: "Status reports", href: "/incidents/reports" },
      { label: "Publish a status report", href: "#guide-publish-status-report" },
      { label: "Public status page", href: "#concept-status-page" },
    ],
  },
  {
    kind: "concept",
    slug: "api-tokens-and-agents",
    title: "API tokens and agents",
    summary:
      "API tokens grant scoped access to the Pulse API without a browser session. Interactive pulsectl sessions link through device approval, while agents and CI use long-lived tokens with explicit scopes. Create, review, and revoke tokens under API Tokens in Settings.",
    demo: "tokens",
    relatedLinks: [
      { label: "API Tokens in Settings", href: "/settings/access" },
      { label: "pulsectl documentation", href: "/docs/cli" },
      { label: "Link pulsectl", href: "#guide-link-pulsectl" },
      { label: "Connect an agent", href: "#guide-connect-agent" },
    ],
  },
  {
    kind: "concept",
    slug: "database-health",
    title: "Database Health",
    summary:
      "Database Health reports how much storage monitoring history uses, what each data category contributes, and how long each detail level is retained. An automatic governor compacts or trims history before the budget is reached, and the card always states the governor's current behavior.",
    demo: "database-health",
    relatedLinks: [
      { label: "Database Health in Settings", href: "/settings/system" },
      { label: "Read Database Health", href: "#guide-database-health" },
    ],
  },
];

const guides: HelpEntry[] = [
  {
    kind: "guide",
    slug: "create-monitor",
    title: "Create a monitor",
    summary:
      "Create a monitor for every endpoint whose availability you need to know. A new monitor starts Pending and settles into Up or Down after its first checks complete.",
    steps: [
      "Open Settings → Monitors.",
      "Select New Monitor.",
      "Enter a name and the URL to check.",
      "Choose the method, check interval, and timeout.",
      "Save, then watch the first checks arrive on the Overview.",
    ],
    demo: "monitor-row",
    relatedLinks: [
      { label: "Monitors in Settings", href: "/settings/monitors" },
      { label: "Monitors", href: "#concept-monitors" },
    ],
  },
  {
    kind: "guide",
    slug: "edit-check-settings",
    title: "Edit check settings",
    summary:
      "Tune how strictly a monitor decides an endpoint is down. Tighter thresholds react faster but can alert on brief blips; looser thresholds wait for repeated failures.",
    steps: [
      "Open Settings → Monitors.",
      "Select Edit on the monitor's row.",
      "Adjust the interval, timeout, and expected status range.",
      "Adjust the failure and recovery thresholds.",
      "Save the monitor.",
    ],
    demo: "check-settings",
    relatedLinks: [
      { label: "Monitors in Settings", href: "/settings/monitors" },
      { label: "Checks and thresholds", href: "#concept-checks-and-thresholds" },
    ],
  },
  {
    kind: "guide",
    slug: "test-monitor",
    title: "Test a monitor",
    summary:
      "Run an immediate check when you want proof an endpoint responds right now — after a deploy, a DNS change, or a fix. The result shows the status code and latency without waiting for the next scheduled check.",
    steps: [
      "Open the monitor from the Overview.",
      "Select Test Monitor.",
      "Read the returned status code and latency in Recent Checks.",
    ],
    demo: "test-monitor",
    relatedLinks: [
      { label: "Overview", href: "/" },
      { label: "Checks and thresholds", href: "#concept-checks-and-thresholds" },
    ],
  },
  {
    kind: "guide",
    slug: "pause-monitor",
    title: "Pause or resume monitoring",
    summary:
      "Pause a monitor during planned maintenance so expected downtime never opens incidents or sends alerts. Paused time is recorded as Paused, not Down, and checks resume the moment you switch the monitor back on.",
    steps: [
      "Open Settings → Monitors.",
      "Find the monitor's row.",
      "Switch Enabled off to pause.",
      "Switch it back on to resume checking.",
    ],
    demo: "pause-toggle",
    relatedLinks: [
      { label: "Monitors in Settings", href: "/settings/monitors" },
      { label: "Monitor states", href: "#concept-monitor-states" },
    ],
  },
  {
    kind: "guide",
    slug: "investigate-incident",
    title: "Investigate an incident",
    summary:
      "Start from the incident, not the monitor: the event trail shows exactly when failures started, when the outage was confirmed, and what alert emails went out.",
    steps: [
      "Open Incidents.",
      "Select the incident to investigate.",
      "Read the opening failure for the first observed error.",
      "Follow the event trail from first failure to recovery.",
      "Open the monitor for latency history and recent checks.",
    ],
    demo: "incident",
    relatedLinks: [
      { label: "Incidents", href: "/incidents" },
      { label: "Incidents and recovery", href: "#concept-incidents" },
    ],
  },
  {
    kind: "guide",
    slug: "configure-alerts",
    title: "Configure alert recipients",
    summary:
      "Default recipients receive alerts for every monitor that has no list of its own. Give a monitor specific recipients when its outages concern a different team.",
    steps: [
      "Open Settings → Notifications.",
      "Enter one address per line, up to 20.",
      "Select Save Recipients.",
      "For monitor-specific routing, edit that monitor and set its recipients.",
    ],
    demo: "alerts",
    relatedLinks: [
      { label: "Notifications in Settings", href: "/settings/notifications" },
      { label: "Alerts and recipients", href: "#concept-alerts" },
    ],
  },
  {
    kind: "guide",
    slug: "test-email",
    title: "Test email delivery",
    summary:
      "Send a test email before you depend on alerts: it verifies the sender, the delivery provider, and the first recipient address in one step.",
    steps: [
      "Open Settings → Notifications.",
      "Confirm a sender appears beneath the recipients list.",
      "Select Send Test Email.",
      "Check the first recipient's inbox for the test message.",
    ],
    demo: "email-test",
    relatedLinks: [
      { label: "Notifications in Settings", href: "/settings/notifications" },
      { label: "Alerts and recipients", href: "#concept-alerts" },
    ],
  },
  {
    kind: "guide",
    slug: "share-status-page",
    title: "Share the status page",
    summary:
      "The status page is public by design: viewers need no account and always see live states. Share it instead of answering \"is it down?\" by hand.",
    steps: [
      "Open Status Page from the top navigation.",
      "Copy the page address from the browser.",
      "Share the address with your team or customers.",
    ],
    demo: "status-page",
    relatedLinks: [
      { label: "Status page", href: "/status" },
      { label: "Public status page", href: "#concept-status-page" },
    ],
  },
  {
    kind: "guide",
    slug: "publish-status-report",
    title: "Publish a status report",
    summary:
      "Authored reports tell the story behind availability: what happened, what you are doing about it, and when it ended. Publish one whenever an outage or a maintenance window deserves narrative beyond the automatic incident row.",
    steps: [
      "Open Incidents and select the Reports tab.",
      "Select Create status report.",
      "Choose incident or maintenance and enter a title.",
      "Pick the affected services and each one's impact.",
      "Write the first update, then select Publish.",
    ],
    demo: "status-page",
    relatedLinks: [
      { label: "Status reports", href: "/incidents/reports" },
      { label: "Publish vs draft reports", href: "#concept-report-drafts" },
      { label: "Status page", href: "/status" },
    ],
  },
  {
    kind: "guide",
    slug: "post-report-update",
    title: "Post an update to an ongoing report",
    summary:
      "Each update adds a timestamped step to the public timeline, and the newest update's status becomes the report's current status. A Resolved or Completed update closes the report and moves it into history.",
    steps: [
      "Open Incidents and select the Reports tab.",
      "Select the ongoing report.",
      "Choose the update status — Investigating, Identified, Monitoring, or Resolved.",
      "Write the update in Markdown.",
      "Post the update; the status page reflects it immediately.",
    ],
    demo: "status-page",
    relatedLinks: [
      { label: "Status reports", href: "/incidents/reports" },
      { label: "Publish a status report", href: "#guide-publish-status-report" },
    ],
  },
  {
    kind: "guide",
    slug: "promote-incident-report",
    title: "Promote an outage to a report",
    summary:
      "Promotion turns an automatic outage row into an editable draft report prefilled with the incident's title, start time, and affected monitor. The draft never publishes itself; once published, the report replaces the raw incident card on the status page.",
    steps: [
      "Open Incidents.",
      "Select Write report on the outage's row.",
      "Edit the prefilled draft — title, window, affected services, and the first update.",
      "Select Publish when the narrative is ready.",
    ],
    demo: "incident",
    relatedLinks: [
      { label: "Incidents", href: "/incidents" },
      { label: "Publish vs draft reports", href: "#concept-report-drafts" },
    ],
  },
  {
    kind: "guide",
    slug: "customize-status-page",
    title: "Customize your status page",
    summary:
      "The status page carries your identity: name, logo, links, announcement, and how much history it shows. Saved changes reach every visitor within about thirty seconds.",
    steps: [
      "Open Settings → Status page.",
      "Adjust personalization, links, announcement, look and feel, or history.",
      "Select Save in the unsaved-changes bar.",
      "Select View status page to check the result.",
    ],
    demo: "status-page",
    relatedLinks: [
      { label: "Status page in Settings", href: "/settings/status-page" },
      { label: "Status page", href: "/status" },
      { label: "Public status page", href: "#concept-status-page" },
    ],
  },
  {
    kind: "guide",
    slug: "link-pulsectl",
    title: "Link pulsectl",
    summary:
      "Link the CLI once per device: pulsectl opens the browser for approval and stores the session in your operating-system keyring, so no token ever touches your shell.",
    steps: [
      "Install pulsectl with Homebrew.",
      "Run pulsectl me with your server address.",
      "Approve the device in the browser window that opens.",
      "Confirm the command prints your signed-in account.",
    ],
    demo: "cli-link",
    relatedLinks: [
      { label: "pulsectl documentation", href: "/docs/cli" },
      { label: "API tokens and agents", href: "#concept-api-tokens-and-agents" },
    ],
  },
  {
    kind: "guide",
    slug: "connect-agent",
    title: "Connect an agent",
    summary:
      "Agents and CI authenticate with a scoped token in the environment — never the device flow. Scope tokens to the least access the job needs, and revoke them from Settings when the job is gone.",
    steps: [
      "Create a token under Settings → Access.",
      "Copy the token when it is shown — it appears once.",
      "Export it as PULSECTL_TOKEN in the agent's environment.",
      "Prefer JSON output for machine parsing.",
    ],
    demo: "agent-connect",
    relatedLinks: [
      { label: "API Tokens in Settings", href: "/settings/access" },
      { label: "pulsectl documentation", href: "/docs/cli" },
    ],
  },
  {
    kind: "guide",
    slug: "database-health",
    title: "Read Database Health",
    summary:
      "Check Database Health when you want to know whether monitoring history fits its storage budget. Watch the projection against the budget, the oldest retained data per detail level, and the governor's current mode — it explains any automatic compaction before it happens.",
    demo: "database-health",
    relatedLinks: [
      { label: "Database Health in Settings", href: "/settings/system" },
      { label: "Database Health", href: "#concept-database-health" },
    ],
  },
  {
    kind: "guide",
    slug: "change-password",
    title: "Change your password",
    summary:
      "Changing your password signs out every other session automatically, so an exposed credential stops working the moment the new one exists. Passwords must be 12 to 128 characters.",
    steps: [
      "Open Settings → Security.",
      "Enter your current password.",
      "Enter and confirm the new password.",
      "Select Change Password.",
    ],
    demo: "tokens",
    relatedLinks: [
      { label: "Security in Settings", href: "/settings/security" },
      { label: "Manage active sessions", href: "#guide-manage-sessions" },
    ],
  },
  {
    kind: "guide",
    slug: "manage-sessions",
    title: "Manage active sessions",
    summary:
      "The Active Sessions table lists every signed-in browser with its IP address and last activity, so you can spot a session you do not recognize and end it. Your current session is badged and cannot revoke itself.",
    steps: [
      "Open Settings → Security.",
      "Review the Active Sessions table.",
      "Select Revoke on a session, then Confirm.",
      "Use Sign Out Other Sessions to end everything except this one.",
    ],
    demo: "tokens",
    relatedLinks: [
      { label: "Security in Settings", href: "/settings/security" },
      { label: "Change your password", href: "#guide-change-password" },
    ],
  },
  {
    kind: "guide",
    slug: "override-timezone",
    title: "Override your time zone on one device",
    summary:
      "The account time zone applies everywhere you sign in. A device override changes only the device you set it on — useful while traveling — and the Account page shows provenance whenever one is active.",
    steps: [
      "Open Settings → Account.",
      "Select Use a different time zone on this device.",
      "Choose the zone for this device.",
      "Select Reset later to return to the account time zone.",
    ],
    demo: "timeline",
    relatedLinks: [
      { label: "Account in Settings", href: "/settings/account" },
    ],
  },
];

export type HelpGroup = { label: string; entries: HelpEntry[] };

export const helpGroups: HelpGroup[] = [
  { label: "Core Concepts", entries: concepts },
  { label: "How-to Guides", entries: guides },
];

export const helpEntries: HelpEntry[] = helpGroups.flatMap((group) => group.entries);

export function findHelpEntryId(hash: string): string | null {
  const id = hash.replace(/^#/, "");
  return helpEntries.some((entry) => helpEntryId(entry) === id) ? id : null;
}

/** The section whose heading is above the reading line, else the first section. */
export function activeHelpSectionId(
  positions: Array<{ id: string; top: number }>,
  scrollY: number,
  offset: number,
): string | null {
  if (positions.length === 0) return null;
  let active = positions[0]!.id;
  for (const position of positions) {
    if (position.top <= scrollY + offset) active = position.id;
    else break;
  }
  return active;
}
