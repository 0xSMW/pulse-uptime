# Pulse — Design System & Interface Specification

Companion to `INIT.md` (engineering source of truth) and built on Vercel's Geist design system — token values come from `geist-design-dark.md` and `geist-design-light.md` (saved from vercel.com/design.dark.md and vercel.com/design.md). This document defines the visual system and screen layouts; INIT.md defines behavior, data, and calculations. Conflicts resolve in this order: INIT.md → this document → `prototype.html` for pixel values.

## 1. Identity

The product is an instrument, not a dashboard. One question — "is anything down?" — answered in under one second of looking.

Absolute rules:

1. Color carries state and nothing else. Green = `UP`, amber = `VERIFYING_DOWN` / `VERIFYING_UP`, red = `DOWN`, gray = `PENDING` / `PAUSED` / `ARCHIVED` / no data. Status colors appear **only** inside StatusDot, StatusBadge, TimelineBar, and the state banners. Everything else is grayscale.
2. All numbers, URLs, timestamps, durations, and status codes are set in Geist Mono with `font-variant-numeric: tabular-nums`.
3. Geist radii: 6px for surfaces and controls, 12px for menus and modals, 9999px for pills and dots. One border weight: 1px. Shadows are Geist's card/popover/modal values only.
4. Dark is the default theme. Light is a first-class option, toggled by the user, persisted.
5. Density over whitespace: data tables at 13px, row height 44px, no cards-within-cards.

## 2. Theming architecture

- `next-themes` with `attribute="data-theme"`, `defaultTheme="dark"`, `enableSystem={true}`.
- Tokens are CSS custom properties on `:root` (Geist dark values) and `[data-theme="light"]` overrides (Geist light values), mapped into shadcn's variables so stock components inherit.
- Theme control lives in Settings → Appearance: a three-option segmented control (System / Dark / Light). Nothing theme-related in the top bar.
- `color-scheme` follows theme. The public status page follows the visitor's `prefers-color-scheme` instead of the admin's saved choice.

## 3. Design tokens

All values are Geist tokens. The Geist step scale encodes intent: 100 background, 400 default border, 700 solid fill, 900 secondary text/icons, 1000 primary text.

### 3.1 Neutrals

| Token | Dark (Geist) | Light (Geist) | Use |
|---|---|---|---|
| `--bg` | `#000000` background-100 | `#FFFFFF` background-100 | Page and card surface — separation comes from borders, not surface tint |
| `--hover` | `#FFFFFF12` gray-alpha-100 | `#0000000D` gray-alpha-100 | Row hover, tertiary-button hover, active tab fill |
| `--border` | `#FFFFFF17` gray-alpha-200 | `#EBEBEB` gray-200 | Dividers, table hairlines |
| `--border-strong` | `#FFFFFF24` gray-alpha-400 | `#EAEAEA` gray-400 | Card and input borders |
| `--border-hover` | `#FFFFFF3D` gray-alpha-500 | `#C9C9C9` gray-500 | Input/button hover borders |
| `--fg` | `#EDEDED` gray-1000 | `#171717` gray-1000 | Primary text |
| `--fg-muted` | `#A0A0A0` gray-900 | `#4D4D4D` gray-900 | Secondary text, labels, table headers |
| `--fg-faint` | `#8F8F8F` gray-700 | `#8F8F8F` gray-700 | Timestamps, placeholders, disabled |
| `--chip-bg` | `#FFFFFF12` | `#F2F2F2` gray-100 | Scope chips, small tags — 100-step fill, **no border** |
| `--code-bg` / `--code-border` | `#FFFFFF12` / `#FFFFFF17` | `#FAFAFA` background-200 / `#EAEAEA` | Code blocks |
| `--down-border` | `#E2162A` red-800 | `#FFD7D6` red-400 | Destructive-outline button border (text stays `--down-text`) |

Light mode uses the **solid** gray scale for borders (Vercel's own light dashboard: `#eaeaea` cards, `#c9c9c9` hover), never stepped-up alpha grays — 21% black outlines read heavy and were the mistake in the first light pass. Dark mode keeps alpha grays because they layer over pure black. Small elements (chips, code) take 100-step fills without borders in both themes.

### 3.2 Status

Per Geist scale semantics — fill from the 700 step, text from the 900 step, background from the 100 step:

| Purpose | Dark | Light |
|---|---|---|
| `--up` (fill: dots, segments) | `#00AC3A` green-700 | `#28A948` green-700 |
| `--up-text` (badge/label text) | `#00CA50` green-900 | `#107D32` green-900 |
| `--up-bg` (badge/banner fill) | `#002608` green-100 | `#ECFDEC` green-100 |
| `--verifying` | `#FFAE00` amber-700 | `#FFAE00` amber-700 |
| `--verifying-text` | `#FF9300` amber-900 | `#AA4D00` amber-900 |
| `--verifying-bg` | `#2A1700` amber-100 | `#FFF6DE` amber-100 |
| `--down` | `#F13242` red-700 | `#FC0035` red-700 |
| `--down-text` | `#FF565F` red-900 | `#D8001B` red-900 |
| `--down-bg` | `#330A11` red-100 | `#FFEEEF` red-100 |
| `--error-solid` (destructive buttons) | `#E2162A` red-800 | `#EA001D` red-800 |
| `--neutral-state` | `#878787` gray-600 | `#A8A8A8` gray-600 |

State → UI label mapping (INIT.md `MonitorState`): `UP` → Up (green), `VERIFYING_DOWN` / `VERIFYING_UP` → Verifying (amber), `DOWN` → Down (red), `PENDING` → Pending (gray), `PAUSED` → Paused (gray), `ARCHIVED` → never rendered in lists.

### 3.3 Accent

No brand accent. Primary button is Geist's: solid gray-1000 fill with background-100 label. Links are `--fg` with underline on hover. Focus ring is Geist's two-layer ring: `box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px <blue>` where blue is `#47A8FF` (blue-900) dark, `#006BFF` (blue-700) light — the only place blue appears.

### 3.4 Typography

Geist Sans for UI, Geist Mono for data; load via `next/font`, weights 400/500/600. Sizes map to Geist typography tokens:

| Role | Geist token | Spec |
|---|---|---|
| Page title | heading-20 | 20px/26px, 600, −0.4px tracking |
| Section/card heading | heading-14 | 14px/20px, 600, −0.28px tracking |
| Body, form labels | label-14 / copy-14 | 14px/20px, 400–500 |
| Table cells, secondary UI | label-13 | 13px/16px, 400 |
| Data (latency, %, timestamps, URLs, codes) | label-13-mono | 13px mono, tabular-nums |
| Meta, table headers, badges | label-12 / button-12 | 12px/16px; headers uppercase +0.05em |
| Stat values | — | 24px/32px, 600, mono |

Maximum two font weights per view (Geist rule): 400/500 for content plus 600 for headings.

### 3.5 Layout, elevation, motion

- **Top nav, single row, no sidebar.** One sticky header row: wordmark left, tab bar (Overview, Incidents, Settings, Status Page ↗) immediately after it, signed-in email right. Active tab: 2px `--fg` underline; inactive `--fg-muted`, `--fg` on hover. No persistent bottom border on the nav — selection and hover states carry the structure alone.
- Content column: max-width 1200px (Geist), padding 32px clamp(16px, 3vw, 24px).
- **Responsive.** Geist breakpoints. Table cells never wrap (`white-space: nowrap` — a date breaking across two lines is a rendering failure). Every table sheds secondary columns before anything wraps, clips, or scrolls: overview drops Last Checked → Timeline → Incident; tokens drops Last Used → prefix → Scopes; incidents drops Status + Notifications → Resolved + Opening Failure; settings monitors drops Group → method/interval. The keep-priority is always identity + state + primary number + action. Hidden-scrollbar horizontal scroll remains only as a last-resort fallback. Stat rows use `auto-fit, minmax(160px, 1fr)`; form field pairs stack below 640px; sheet width `min(480px, 100vw)`.
- Cards: `--bg` fill, 1px `--border-strong`, **12px radius** (Geist `rounded.md` — panels take md, controls stay at 6px sm, matching Vercel's dashboard), 24px padding, Geist raised-card shadow (`0 1px 2px rgba(0,0,0,.16)` dark, `0 2px 2px rgba(0,0,0,.04)` light). 24px between stacked cards. Never nested.
- **Page-level toolbar** (Vercel pattern): search and primary actions sit above the panel, not inside its header — search stretches to fill, actions right, everything 40px tall, 8px gaps, 16px above the panel.
- Tables: single-line rows 48px, two-line rows (name + URL) 60px; cell padding 0 16px with **24px first/last-cell inset** so row content aligns to the card's 24px padding; `--border` hairlines, `--hover` on row hover, full row clickable where a detail exists. Numeric columns (uptime, latency) right-aligned. Horizontal scroll regions hide their scrollbars (`scrollbar-width: none`) while staying scrollable.
- TimelineBar segments: 2px gap, 3px minimum width, 1.5px radius — segments must read wider than their gaps or the bar becomes a barcode.
- Spacing: Geist 4px scale — 8px inside a group, 16px between groups, 24px between cards, 32–40px between sections.
- Motion: Geist easing `cubic-bezier(0.175, 0.885, 0.32, 1.1)`; ~150ms state changes, 200ms tooltips, 300ms sheet. Most interactions instant. Honor `prefers-reduced-motion` (drop the pulse animation). No theme-switch transition.

## 4. Custom components

### 4.1 StatusDot

```ts
type StatusDotProps = {
  state: "UP" | "VERIFYING_DOWN" | "VERIFYING_UP" | "DOWN" | "PENDING" | "PAUSED";
  size?: "sm" | "md";   // 8px | 10px
};
```

Solid circle, fill from the 700-step (`--up` / `--verifying` / `--down` / `--neutral-state`). `DOWN` and `VERIFYING_*` pulse (scaling ring, 2s ease-out); `UP`, `PENDING`, `PAUSED` never pulse. Always paired with a visible label or `aria-label`.

### 4.2 StatusBadge

Pill: 100-step background, 900-step text, 12px/500, 2px 8px padding, 9999px radius, dot prefix, label per §3.2 mapping.

### 4.3 TimelineBar

Availability timeline per INIT.md's fixed buckets.

```ts
type TimelineBarProps = {
  buckets: {
    start: string;
    result: "all_success" | "mixed" | "all_failed" | "no_checks" | "paused";
    uptimePct: number | null;
    checkCount: number;
  }[];
  height?: number; // 24 overview, 32 detail
};
```

Bucket counts (INIT.md): 24h → 60 × 24min; 7d → 60 × 168min; 30d → 60 × 12h; 90d → 90 × 1d. The overview table renders the 24-hour range.

Fills: `all_success` → `--up`; `mixed` → `--verifying`; `all_failed` → `--down`; `no_checks` → `--border-strong`; `paused` → 45° hatch of `--border-strong`. Segments: flex row, 3px gap, 2px radius. Hover brightens and shows a tooltip (Geist popover shadow): bucket start (mono), uptime % per §7, downtime if any. Detail captions: range start left, "Now" right, 11px mono `--fg-faint`.

### 4.4 LatencyChart

Detail page, Recharts `AreaChart`. Server aggregates to ≤ 240 points (INIT.md).

Stroke `--fg` 1.5px; fill gradient `--fg` 8% → 0%; horizontal-only grid in `--border`; 11px mono ticks in `--fg-faint`, no axis lines; `ms` suffix on 3 Y ticks. Tooltip matches TimelineBar's. Failed checks: 3px `--down` dots at the top edge.

## 5. Stock shadcn usage

Install: `button`, `input`, `label`, `select`, `switch`, `dialog`, `sheet`, `dropdown-menu`, `table`, `tooltip`, `sonner`, `tabs`, `separator`, `skeleton`. Restyle to Geist component tokens:

- Buttons — 40px default, 32px small, 6px radius, `button-14` type, 0 10px padding (0 6px small). Variants: primary = solid gray-1000 fill; secondary = `--bg` fill + `--border-strong` border; tertiary = transparent, `--hover` tint on hover; error = solid `--error-solid` fill, white text.
- Inputs — 40px (32px small), `--bg` fill, `--border-strong` border stepping to `--border-hover` on hover, 0 12px padding.
- Sheet (right, 480px) for monitor create/edit; Dialog (12px radius) only for destructive confirmation — delete requires typing the monitor name.
- Sonner toasts bottom-right. Skeletons mirror final layout; no spinners.
- Data refresh: SWR, 30-second interval on dashboard and status page (INIT.md). No WebSockets.

Voice (Geist): Title Case for buttons, labels, tabs, column headers; sentence case for body and helper text. Actions are verb + noun — "New Monitor", "Test Monitor", "Pause Monitor", "Send Test Email", "Save Monitor", "Delete Monitor" — never "Confirm" or "OK". Toasts name the thing that changed with no trailing period ("Monitor created"), never "successfully". In-progress states use the present participle: "Saving…", "Checking…".

## 6. Screens

Admin shell on all screens: top nav per §3.5. Routes and file layout per INIT.md repository structure.

### 6.0 Onboarding and login

`/onboarding` appears only when no administrator exists. Use a centered 420px column with the Pulse wordmark, heading "Create Admin Account", and Email, Password, and Confirm Password fields followed by a full-width "Create Account" primary button. Successful creation signs the administrator in and opens the Overview. Once the account exists, this route redirects to `/login` and rejects direct submissions.

`/login` uses the same shell with heading "Sign In", Email and Password fields, and a full-width "Sign In" primary button. Keep errors generic ("Email or password is incorrect"), preserve the email value, focus the password field after failure, and expose no social-login, SSO, magic-link, registration, or provider controls.

### 6.1 Overview `/`

1. **Internal health banner** (INIT.md observability) — renders only when triggered: no successful cron run for 3 minutes, invalid Edge Config, dead outbox rows, or maintenance stale 48h. Amber banner, message per INIT table, phrased as what happened plus what to do. Absent otherwise.
2. **Monitor table** — the page's only permanent content; columns exactly (INIT.md):

| Column | Value |
|---|---|
| Status | StatusDot + state label (13px/500) |
| Monitor | Name 13px/500; URL below 12px mono `--fg-faint` |
| Uptime 24h | mono, per §7 |
| Timeline | TimelineBar, 24-hour range, 60 segments, height 24 |
| Latency | Latest successful response, mono; "—" if none |
| Last Checked | Relative timestamp, mono `--fg-muted` |
| Incident | Active incident duration (mono, `--down-text`) or blank |

Sort (INIT.md): `DOWN`, `VERIFYING_DOWN`, `VERIFYING_UP`, `PENDING`, `UP`, `PAUSED`; alphabetical within each state. `DOWN` rows get a 3px `--down` inset bar on the left edge. Row click → monitor detail. Above the panel, the page-level toolbar (§3.5): search stretching full width (magnifier icon, `/` keyboard chip, filters rows live per keystroke over name + URL, panel collapses to fit) and "New Monitor" primary right. The panel itself has no header — the table's column headers open it.

Each row also carries a hover-revealed "⋯" actions button (invisible at rest, opacity transition; stays visible while its menu is open and the row keeps its hover fill). The menu (12px radius, popover shadow): View Incidents, Test Monitor, Pause/Resume Monitor, Edit Monitor, separator, Remove in `--down-text`. Disabled items stay hoverable and explain themselves in a tooltip — what's wrong plus what to do (e.g. "Monitor is paused. Resume it to run a test.").

The aggregate stat row (Operational / Verifying / Down / Average uptime) was removed by decision on 2026-07-18 — the sorted table with the health banner communicates the same information; INIT.md's Overview section is updated to match.

### 6.2 Monitor detail `/monitors/[monitorId]`

1. **Header** — back link "← Overview"; name (heading-20) + StatusBadge; method chip + full URL 13px mono `--fg-muted`. Actions right: "Test Monitor", "Pause Monitor"/"Resume Monitor", "Edit Monitor" — all secondary buttons.
2. **Stat row** — 4 cards: Latest Latency (p95 beneath, 12px mono), Uptime 24h, 7d, 30d. Uptime values: `--verifying-text` below 99.9%, `--down-text` below 99%.
3. **Current/latest incident strip** — active: red-tinted card (condensed §6.3 ongoing card). Resolved within 24h: neutral single-line card.
4. **Availability card** — heading "Availability" + range uptime % (mono); segmented tabs 24h / 7d / 30d / 90d; TimelineBar height 32.
5. **Response Time card** — segmented tabs 24h / 7d / 30d; LatencyChart 220px.
6. **Recent Incidents** — last 5: Started / Duration / Opening failure (mono), "View All" tertiary link.
7. **Recent Checks** — Time (mono), Result (dot + "200 OK" / error code, failures in `--down-text`), Latency. 20 rows; failed rows tinted `--down-bg` at 40%.
8. **Configuration card** — read-only: method, interval, timeout, expected status range, thresholds, recipient count. Labels `--fg-muted`, values mono. "Edit Monitor" tertiary button.

### 6.3 Incidents `/incidents`

1. Header: "Incidents", filter Select (All / Ongoing / Resolved).
2. **Ongoing incident card**: `--down-bg` fill, `--down` 40% border, pulsing dot, name, "Ongoing" badge, started + elapsed (mono, updates each minute), cause 13px mono.
3. **History table** (INIT.md): Monitor, State (Resolved badge is neutral gray, never green), Started, Resolved, Duration, Opening Failure, Status, Notifications ("Sent · 2"; "Retrying" in `--verifying-text`; "Dead" in `--down-text`).
4. **Incident detail** — every incident has a canonical route `/incidents/[incidentId]` (INIT.md; outage and recovery emails link here). The page: back link, monitor name + Ongoing/Resolved badge, started/resolved/duration stat row (mono), cause line, and the full event trail — first failed check → failure confirmed → outage email queued → outage email sent → first successful check → recovery confirmed → recovery email queued → recovery email sent. Timestamps 11px mono; unreached events omitted. The incident list may additionally expand the same trail inline; row click navigates to the route.
5. Empty state: green StatusDot, "No incidents yet. Add monitors in Settings to start checking." 13px `--fg-muted`. No illustration.

### 6.4 Settings `/settings`

One page, no tabs — five stacked cards:

1. **Monitors** — table (dot + name, URL mono, "GET · 1m · 8s timeout" 12px mono, group, enabled Switch, Edit tertiary). "New Monitor" primary in the card header.
2. **Notifications** — Default Recipients (textarea mono), User Agent (read-only mono), sender line, "Send Test Email" secondary button.
3. **API Tokens** (CLI-INIT.md) — table: Name (with kind beneath: "Agent token" / "CLI session · darwin/arm64"), token prefix (mono, "pulse_live_3fk9····"), Scopes (pill chips, 11px mono), Expires (mono), Last Used (mono relative), Revoke (error-outline small). "Create Token" primary in the card header opens a sheet: Name, Scopes (a "Select All" checkbox — indeterminate when partially selected — above the checkbox list of the eight CLI-INIT scopes, separated by a hairline), Expires (30 days / 90 days / 1 year). After create, the sheet body swaps to the show-once state: full secret in an amber-tinted mono box, Copy button, "Copy it now. It won't be shown again.", Done. The secret never renders again anywhere — lists show prefix only.
4. **CLI** — install-and-link snippet in a copyable code block (mono, 12px, `--hover` fill): brew install, `pulsectl me --server <current-origin>`, and `export PULSECTL_TOKEN=…` for agents. Link to the device-approval screen.
5. **Appearance** — three-option segmented control: System / Dark / Light. Persisted; System tracks `prefers-color-scheme` live.

### 6.4a Device authorization `/cli/authorize`

Approval page for CLI installation linking (CLI-INIT.md device flow). Authenticated route, centered 480px column:

1. Heading "Authorize pulsectl" and a bordered card using only Geist grayscale plus state colors.
2. Client row with the Pulse status dot, `pulsectl`, and the installation name. Supporting copy identifies the signed-in account: "Stephen’s Mac wants full access to stephen@klu.ai."
3. Requesting-device meta line, 12px mono `--fg-muted`: CLI version · platform/architecture · IP.
4. Read-only permission panel with five plain-language rows: Manage monitors; View incidents and private status; View and apply configuration; Send test notifications; Manage API tokens. There is no scope selector.
5. User-code confirmation beneath the permissions: code in 16px/600 mono and "Matches the code shown in your terminal" in short muted copy. If the URL carries no code, show an input instead.
6. Footer actions: "Cancel" secondary and "Authorize" primary, equal width in a row and stacked on narrow screens.
7. Approved state replaces the card: green dot, "Installation linked", "Return to your terminal". Cancelled state uses neutral gray and "Request cancelled".

Create/Edit Sheet fields mirror INIT.md `MonitorConfig` exactly, in order: Name, URL (mono), Group, Method, Interval (1/5/10/15 min), Timeout ms (1000–15000), Expected Status Min + Max, Failure Threshold (1–5), Recovery Threshold (1–5), Recipients (textarea, one per line, max 20; hint: "Empty inherits default recipients"), Enabled. Inline validation 12px `--down-text`, rules per INIT.md. Save surfaces propagation: "Updating configuration…" for 10 seconds, then refresh. 409 conflict: "Configuration changed elsewhere. Reload before saving."

### 6.5 Public status page `/status`

Standalone layout — no top nav, no auth. Centered 720px column, 48px top padding. Follows visitor `prefers-color-scheme`.

1. **Header** — status page name (heading-16) left; "Last updated HH:MM:SS UTC" 12px mono right.
2. **Overall state banner** — per INIT.md: any `DOWN` → red "Major Outage"; verifying only → amber "Investigating"; all up → green "All Systems Operational"; none enabled → gray "No Monitors Configured". 15px/600, dot, 100-step tinted fill.
3. **Current incidents** — red-tinted cards: monitor name, started, elapsed, cause. Nothing more.
4. **Grouped monitor list** — one card per group: dot + name, 90-day TimelineBar, 90-day uptime % (mono) per row.
5. **Recent resolved incidents** — last 10: monitor, started, duration. Neutral.

Never rendered (INIT.md): recipients, error stacks, config versions, cron runs, archived monitors, admin notes, monitor URLs.

## 7. Formatting rules

- **Uptime in tables**: two decimals ("99.93%", "100%" stays "100.00%"). Full precision moves to a hover tooltip: 4-decimal value (INIT.md rule), check count, failed count ("99.9306% · 1,440 checks · 1 failed"). Stat cards and the Availability heading keep INIT.md's display rule: four decimals above 99%, two otherwise.
- **Latency**: integer ms, "142 ms". Durations: "42s", "18m 4s", "1h 12m", "2d 4h".
- **Relative time**: < 60s "Xs ago", < 60m "Xm ago", then "HH:MM" UTC, older than today "Jul 12, 14:03". Mono.
- **Loading**: skeletons mirroring final layout. **Errors**: what happened plus what to do next, inline, with a Retry secondary button.

## 8. Accessibility

- State never by color alone — dot always paired with a text label or `aria-label`.
- WCAG AA (4.5:1) for all text pairs in both themes.
- Geist focus ring on every interactive element at `:focus-visible`; never remove an outline without a replacement.
- TimelineBar: `role="img"` with summary `aria-label`; keyboard focus steps segments.
- Row-click tables must also contain a real link.

## 9. Microinteractions

Adopted from a frame-by-frame study of Better Stack's monitors list (video-ping.mov, 20.8s @ 60fps). The governing principle: everything ambient is slow and subtle, everything responsive is instant. Motion communicates liveness, never decoration — consistent with Geist's motion rules.

1. **Status dot ping.** In Better Stack, each row's status dot periodically swells with an expanding translucent halo, staggered across rows — the list reads as alive without anything moving fast. Pulse adopts it with cause: a dot pings once (halo expands ~3×, 1.1s ease-out, single run) when that monitor's check completes. At a 1-minute interval that's one quiet ping per row per minute. `DOWN` and `VERIFYING` dots keep their continuous pulse; `PAUSED` never moves.
2. **Live durations.** Better Stack's meta line ("Paused · 2y 5mo 4d 17h 27m") ticks by the minute without reload. Pulse ticks "Last Checked" per second ("12s ago" → "13s ago"), resetting on each check — the reset is what triggers the ping.
3. **Progressive disclosure on hover.** Row and group controls are invisible at rest and fade in on hover (150ms opacity); the row's "⋯" stays visible while its menu is open and the row keeps its hover fill. Chrome at rest: zero.
4. **Disabled controls explain themselves.** Better Stack's dimmed "Rename" still responds to hover with why it's disabled and what to do instead. Every disabled control in Pulse gets a tooltip in that shape: cause + next action.
5. **Icon tooltips.** Every icon-only button shows a one-word tooltip (~200ms delay, popover shadow). No icon is left unlabeled.
6. **Search as a first-class object.** Magnifier icon, `/` keyboard chip inside the field, focus ring on entry, live filtering per keystroke with the card collapsing to fit, "×" to clear, list restores instantly. No submit button, no debounce theater.
7. **Plain-language actions.** Better Stack's create menu names failure conditions as sentences ("URL becomes unavailable"), not monitor-type jargon. Pulse keeps this at the copy level: describe monitors and errors by what the user observes.
8. **Menus close fast.** Open instant, close with a ~100ms fade. Nothing bounces.
9. **Command palette (⌘K / Ctrl+K).** Centered 560px dialog, 12px radius, modal shadow, opened from anywhere in the admin (a `⌘K` kbd chip in the top bar advertises it; not available on the public status page). Three groups: Navigation (the four nav destinations), Monitors (dot + name, latency or state as the right-aligned mono hint, enter → monitor detail), and Live Incidents — `DOWN` monitors only, "name — cause" with "ongoing · elapsed" in `--down-text`; the group is absent when nothing is down. Substring match over item text; ↑↓/↵/esc; footer shows the three keys; `/` still focuses the overview search directly.

Deliberately not adopted: drag-to-reorder groups, the onboarding checklist card, and the always-breathing dot on paused monitors (a paused monitor is not alive; its dot holds still).

## 10. Component file placement

Follows INIT.md repository structure:

```
components/monitors/status-dot.tsx
components/monitors/status-badge.tsx
components/monitors/timeline-bar.tsx
components/charts/latency-chart.tsx
components/dashboard/top-nav.tsx
components/dashboard/health-banner.tsx
components/dashboard/theme-toggle.tsx
components/status/overall-banner.tsx
app/globals.css        ← tokens from §3
lib/reporting/format.ts ← rules from §7
```
