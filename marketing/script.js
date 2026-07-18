(() => {
  "use strict";

  document.documentElement.classList.add("js");

  const stages = [
    {
      state: "UP",
      label: "Up",
      latency: 42,
      controlTitle: "Service is healthy",
      controlCopy: "Every check is passing. Press play to watch Pulse work through an outage.",
      publicTitle: "All systems operational",
      publicStatus: "Operational",
      emailTitle: "Your services are operational",
      emailCopy: "Pulse will send one clear alert when the state changes.",
      emailState: "API is up"
    },
    {
      state: "VERIFYING_DOWN",
      label: "Verifying",
      latency: null,
      controlTitle: "First check fails",
      controlCopy: "One failure is not an incident yet. Pulse verifies before it alerts anyone.",
      publicTitle: "All systems operational",
      publicStatus: "Operational",
      emailTitle: "Confirming API availability",
      emailCopy: "Pulse is verifying the first failed check before alerting.",
      emailState: "Verification in progress"
    },
    {
      state: "DOWN",
      label: "Down",
      latency: null,
      controlTitle: "Outage confirmed",
      controlCopy: "A second failure confirms the outage. The incident opens and one alert goes out.",
      publicTitle: "Partial system outage",
      publicStatus: "Outage",
      emailTitle: "API is down",
      emailCopy: "Two consecutive checks failed with a connection timeout.",
      emailState: "Outage alert sent"
    },
    {
      state: "VERIFYING_UP",
      label: "Verifying",
      latency: 118,
      controlTitle: "Recovery detected",
      controlCopy: "A check succeeds again. Pulse confirms recovery before resolving the incident.",
      publicTitle: "Partial system outage",
      publicStatus: "Monitoring recovery",
      emailTitle: "API recovery detected",
      emailCopy: "Pulse is confirming the endpoint remains available.",
      emailState: "Verification in progress"
    },
    {
      state: "UP",
      label: "Up",
      latency: 46,
      controlTitle: "Incident resolved",
      controlCopy: "Recovery is confirmed and the alert is closed. The full timeline stays in history.",
      publicTitle: "All systems operational",
      publicStatus: "Operational",
      emailTitle: "API recovered",
      emailCopy: "The endpoint is available after a two-minute outage.",
      emailState: "Recovery alert sent"
    }
  ];

  const demo = {
    stage: 0,
    output: "table",
    command: "me",
    theme: document.documentElement.dataset.theme || "dark",
    lastAdded: null,
    dependencies: [
      { id: "openai_api", region: null, fresh: false },
      { id: "vercel_runtime", region: null, fresh: false },
      { id: "neon_database", region: "us-east-1", fresh: false }
    ],
    monitors: [
      { id: "api", name: "API", url: "https://api.example.com/health", uptime: "99.99%", latency: 42, status: "UP", checked: "18s ago" },
      { id: "web", name: "Web App", url: "https://app.example.com", uptime: "100%", latency: 36, status: "UP", checked: "31s ago" },
      { id: "docs", name: "Docs", url: "https://docs.example.com", uptime: "99.98%", latency: 58, status: "UP", checked: "44s ago" }
    ]
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const elements = {
    header: $(".site-header"),
    monitorRows: $("#monitor-rows"),
    simBadge: $("#sim-status-badge"),
    simLatency: $("#sim-latency"),
    largeTimeline: $("#large-timeline"),
    controlHeading: $("#control-heading"),
    controlCopy: $("#control-copy"),
    playButton: $("#play-demo"),
    playLabel: $("#play-label"),
    stepBack: $("#step-back"),
    stepForward: $("#step-forward"),
    incidentBadge: $("#incident-badge"),
    incidentStarted: $("#incident-started"),
    incidentDuration: $("#incident-duration"),
    incidentCause: $("#incident-cause"),
    eventTrail: $("#event-trail"),
    publicState: $("#public-state"),
    publicBrandDot: $(".mini-brand .status-dot"),
    publicMonitorStatus: $("#public-monitor-status"),
    emailCard: $("#email-card"),
    emailTitle: $("#email-title"),
    emailCopy: $("#email-copy"),
    emailState: $("#email-state"),
    terminalOutput: $("#terminal-output"),
    copyCommand: $("#copy-command"),
    toast: $("#toast"),
    dialog: $("#monitor-dialog"),
    themeToggle: $("#theme-toggle"),
    menuToggle: $("#menu-toggle"),
    navLinks: $("#nav-links")
  };

  const CHECK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>';

  const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const DEP_ICONS = {
    openai: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    anthropic: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
    googlecloud: "M12.19 2.38a9.344 9.344 0 0 0-9.234 6.893c.053-.02-.055.013 0 0-3.875 2.551-3.922 8.11-.247 10.941l.006-.007-.007.03a6.717 6.717 0 0 0 4.077 1.356h5.173l.03.03h5.192c6.687.053 9.376-8.605 3.835-12.35a9.365 9.365 0 0 0-2.821-4.552l-.043.043.006-.05A9.344 9.344 0 0 0 12.19 2.38zm-.358 4.146c1.244-.04 2.518.368 3.486 1.15a5.186 5.186 0 0 1 1.862 4.078v.518c3.53-.07 3.53 5.262 0 5.193h-5.193l-.008.009v-.04H6.785a2.59 2.59 0 0 1-1.067-.23h.001a2.597 2.597 0 1 1 3.437-3.437l3.013-3.012A6.747 6.747 0 0 0 8.11 8.24c.018-.01.04-.026.054-.023a5.186 5.186 0 0 1 3.67-1.69z",
    vercel: "m12 1.608 12 20.784H0Z",
    cloudflare: "M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727",
    clerk: "m21.47 20.829-2.881-2.881a.572.572 0 0 0-.7-.084 6.854 6.854 0 0 1-7.081 0 .576.576 0 0 0-.7.084l-2.881 2.881a.576.576 0 0 0-.103.69.57.57 0 0 0 .166.186 12 12 0 0 0 14.113 0 .58.58 0 0 0 .239-.423.576.576 0 0 0-.172-.453Zm.002-17.668-2.88 2.88a.569.569 0 0 1-.701.084A6.857 6.857 0 0 0 8.724 8.08a6.862 6.862 0 0 0-1.222 3.692 6.86 6.86 0 0 0 .978 3.764.573.573 0 0 1-.083.699l-2.881 2.88a.567.567 0 0 1-.864-.063A11.993 11.993 0 0 1 6.771 2.7a11.99 11.99 0 0 1 14.637-.405.566.566 0 0 1 .232.418.57.57 0 0 1-.168.448Zm-7.118 12.261a3.427 3.427 0 1 0 0-6.854 3.427 3.427 0 0 0 0 6.854Z",
    supabase: "M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z",
    upstash: "M13.8027 0C11.193 0 8.583.9952 6.5918 2.9863c-3.9823 3.9823-3.9823 10.4396 0 14.4219 1.9911 1.9911 5.2198 1.9911 7.211 0 1.991-1.9911 1.991-5.2198 0-7.211L12 12c.9956.9956.9956 2.6098 0 3.6055-.9956.9955-2.6099.9955-3.6055 0-2.9866-2.9868-2.9866-7.8297 0-10.8164 2.9868-2.9868 7.8297-2.9868 10.8164 0l1.8028-1.8028C19.0225.9952 16.4125 0 13.8027 0zM12 12c-.9956-.9956-.9956-2.6098 0-3.6055.9956-.9955 2.6098-.9955 3.6055 0 2.9867 2.9868 2.9867 7.8297 0 10.8164-2.9867 2.9868-7.8297 2.9868-10.8164 0l-1.8028 1.8028c3.9823 3.9822 10.4396 3.9822 14.4219 0 3.9823-3.9824 3.9823-10.4396 0-14.4219-.9956-.9956-2.3006-1.4922-3.6055-1.4922-1.3048 0-2.6099.4966-3.6054 1.4922-1.9912 1.9912-1.9912 5.2198 0 7.211z",
    stripe: "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z",
    resend: "M2.023 0v24h5.553v-8.434h2.998L15.326 24h6.65l-5.372-9.258a7.652 7.652 0 0 0 3.316-3.016c.709-1.21 1.062-2.57 1.062-4.08 0-1.462-.353-2.767-1.062-3.91-.709-1.165-1.692-2.079-2.95-2.742C15.737.331 14.355 0 12.823 0Zm5.553 4.87h4.219c.731 0 1.349.125 1.851.376.526.252.925.618 1.2 1.098.274.457.412.994.412 1.611S15.132 9.12 14.88 9.6c-.229.48-.572.856-1.03 1.13-.434.252-.948.38-1.542.38H7.576Z",
    twilio: "M12 0C5.381-.008.008 5.352 0 11.971V12c0 6.64 5.359 12 12 12 6.64 0 12-5.36 12-12 0-6.641-5.36-12-12-12zm0 20.801c-4.846.015-8.786-3.904-8.801-8.75V12c-.014-4.846 3.904-8.786 8.75-8.801H12c4.847-.014 8.786 3.904 8.801 8.75V12c.015 4.847-3.904 8.786-8.75 8.801H12zm5.44-11.76c0 1.359-1.12 2.479-2.481 2.479-1.366-.007-2.472-1.113-2.479-2.479 0-1.361 1.12-2.481 2.479-2.481 1.361 0 2.481 1.12 2.481 2.481zm0 5.919c0 1.36-1.12 2.48-2.481 2.48-1.367-.008-2.473-1.114-2.479-2.48 0-1.359 1.12-2.479 2.479-2.479 1.361-.001 2.481 1.12 2.481 2.479zm-5.919 0c0 1.36-1.12 2.48-2.479 2.48-1.368-.007-2.475-1.113-2.481-2.48 0-1.359 1.12-2.479 2.481-2.479 1.358-.001 2.479 1.12 2.479 2.479zm0-5.919c0 1.359-1.12 2.479-2.479 2.479-1.367-.007-2.475-1.112-2.481-2.479 0-1.361 1.12-2.481 2.481-2.481 1.358 0 2.479 1.12 2.479 2.481z",
    github: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
  };


  function stateClass(state) {
    if (state === "UP") return "up";
    if (state.startsWith("VERIFYING")) return "verifying";
    if (state === "DOWN") return "down";
    return "neutral";
  }

  function statusLabel(state) {
    if (state === "UP") return "Up";
    if (state.startsWith("VERIFYING")) return "Verifying";
    if (state === "DOWN") return "Down";
    return "Pending";
  }

  function timelineClasses(state, count, live, history) {
    const current = stateClass(state);
    return Array.from({ length: count }, (_, index) => {
      if (!live) {
        if (typeof history === "number" && index < count - Math.min(history, count)) return "";
        return index === count - 1 ? current : "up";
      }
      let segmentState = "up";
      if (index === count - 1) segmentState = current;
      if (demo.stage >= 2 && index >= count - 3) segmentState = "down";
      if (demo.stage === 3 && index === count - 1) segmentState = "verifying";
      if (demo.stage === 4 && index === count - 1) segmentState = "up";
      return segmentState;
    });
  }

  function makeTimeline(state, count, live, history) {
    return timelineClasses(state, count, live, history)
      .map((segment) => `<span class="timeline-segment ${segment}" aria-hidden="true"></span>`)
      .join("");
  }

  function syncTimeline(container, state, count, live, history) {
    if (!container) return;
    if (container.children.length !== count) {
      container.innerHTML = makeTimeline(state, count, live, history);
      return;
    }
    timelineClasses(state, count, live, history).forEach((segment, index) => {
      container.children[index].className = `timeline-segment ${segment}`;
    });
  }

  function monitorRowView(monitor, index) {
    const live = index === 0;
    const stage = stages[demo.stage];
    return {
      live,
      state: live ? stage.state : monitor.status,
      latency: live ? stage.latency : monitor.latency,
      uptime: live && demo.stage >= 2 && demo.stage < 4 ? "99.86%" : monitor.uptime,
      checked: live ? "Now" : monitor.checked,
      history: monitor.custom ? monitor.history : null
    };
  }

  function statusCellHTML(state) {
    const status = stateClass(state);
    const pulse = status === "down" || status === "verifying" || state === "PENDING" ? " pulse" : "";
    return `<span class="status-cell"><span class="status-dot ${status}${pulse}"></span>${statusLabel(state)}</span>`;
  }

  function renderMonitors() {
    const rows = $$("tr[data-monitor-id]", elements.monitorRows);
    const sameStructure =
      rows.length === demo.monitors.length &&
      rows.every((row, index) => row.dataset.monitorId === demo.monitors[index].id);

    if (sameStructure) {
      demo.monitors.forEach((monitor, index) => {
        const row = rows[index];
        const view = monitorRowView(monitor, index);
        row.cells[0].innerHTML = statusCellHTML(view.state);
        row.cells[2].textContent = view.uptime;
        syncTimeline($(".mini-timeline", row), view.state, 28, view.live, view.history);
        row.cells[4].textContent = view.latency === null ? "—" : `${view.latency} ms`;
        row.cells[5].textContent = view.checked;
      });
      return;
    }

    elements.monitorRows.innerHTML = demo.monitors.map((monitor, index) => {
      const view = monitorRowView(monitor, index);
      const enter = monitor.id === demo.lastAdded ? " class=\"row-enter\"" : "";
      return `
        <tr${enter} tabindex="0" data-monitor-id="${escapeHtml(monitor.id)}" aria-label="View ${escapeHtml(monitor.name)} monitor">
          <td>${statusCellHTML(view.state)}</td>
          <td><span class="monitor-name">${escapeHtml(monitor.name)}</span><span class="monitor-url">${escapeHtml(monitor.url)}</span></td>
          <td class="numeric mono">${view.uptime}</td>
          <td><div class="mini-timeline" aria-label="24 hour uptime timeline">${makeTimeline(view.state, 28, view.live, view.history)}</div></td>
          <td class="numeric mono">${view.latency === null ? "—" : `${view.latency} ms`}</td>
          <td class="numeric mono last-checked">${view.checked}</td>
        </tr>`;
    }).join("");
    demo.lastAdded = null;

    $$("tr[data-monitor-id]", elements.monitorRows).forEach((row) => {
      const open = () => {
        const monitor = demo.monitors.find((item) => item.id === row.dataset.monitorId);
        showToast(`${monitor.name} monitor selected`);
        $("#simulation").scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" });
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  }

  function renderSimulation() {
    const stage = stages[demo.stage];
    const kind = stateClass(stage.state);
    const stateSurface = `${kind}-state`;
    const pulse = kind === "down" || kind === "verifying" ? " pulse" : "";

    elements.simBadge.className = `status-badge ${stateSurface}`;
    elements.simBadge.innerHTML = `<span class="status-dot ${kind}${pulse}"></span><span>${stage.label}</span>`;
    elements.simLatency.textContent = stage.latency === null ? "—" : `${stage.latency} ms`;
    elements.controlHeading.textContent = stage.controlTitle;
    elements.controlCopy.textContent = stage.controlCopy;
    elements.stepBack.classList.toggle("hidden-step", demo.stage === 0);
    elements.stepBack.disabled = demo.stage === 0;
    elements.stepForward.classList.toggle("is-reset", demo.stage === 4);
    elements.stepForward.setAttribute("aria-label", demo.stage === 4 ? "Reset demo" : "Next step");

    $$(".state-step").forEach((step, index) => {
      step.classList.toggle("complete", index < demo.stage);
      step.classList.toggle("active", index === demo.stage);
    });

    syncTimeline(elements.largeTimeline, stage.state, 48, true);
  }

  let renderedEventCount = 0;
  let lastEmailKey = "";

  function renderIncident() {
    const stage = stages[demo.stage];
    const hasFailedCheck = demo.stage >= 1;
    const incidentOpen = demo.stage >= 2 && demo.stage < 4;
    const incidentResolved = demo.stage === 4;

    if (incidentOpen) {
      elements.incidentBadge.className = "health-label critical";
      elements.incidentBadge.textContent = "Ongoing";
    } else if (incidentResolved) {
      elements.incidentBadge.className = "neutral-badge";
      elements.incidentBadge.textContent = "Resolved";
    } else {
      elements.incidentBadge.className = "neutral-badge";
      elements.incidentBadge.textContent = "No incident";
    }

    elements.incidentStarted.textContent = demo.stage >= 2 ? "12:04:18 UTC" : "—";
    elements.incidentDuration.textContent = demo.stage >= 2 ? (incidentResolved ? "2m 08s" : demo.stage === 3 ? "1m 24s" : "42s") : "—";
    elements.incidentCause.textContent = demo.stage >= 2 ? "TIMEOUT" : "—";

    const events = [];
    if (hasFailedCheck) events.push(["down-event", "First failed check", "12:03:18"]);
    if (demo.stage >= 2) {
      events.push(["down-event", "Failure confirmed", "12:04:18"]);
      events.push(["", "Outage email sent", "12:04:19"]);
    }
    if (demo.stage >= 3) events.push(["up-event", "First successful check", "12:05:18"]);
    if (demo.stage >= 4) {
      events.push(["up-event", "Recovery confirmed", "12:06:18"]);
      events.push(["up-event", "Recovery email sent", "12:06:20"]);
    }

    elements.eventTrail.innerHTML = events.length
      ? events.map(([eventClass, label, time], index) => {
          const fresh = index >= renderedEventCount && !prefersReducedMotion();
          const enterClass = fresh ? " event-enter" : "";
          const delay = fresh ? ` style="animation-delay:${(index - renderedEventCount) * 90}ms"` : "";
          return `<div class="event-item ${eventClass}${enterClass}"${delay}><span class="event-dot"></span><span>${label}</span><time>${time}</time></div>`;
        }).join("")
      : '<div class="empty-trail"><span class="status-dot up"></span><p>No incidents yet</p></div>';
    renderedEventCount = events.length;

    const publicKind = demo.stage === 2 || demo.stage === 3 ? (demo.stage === 2 ? "down" : "verifying") : "up";
    elements.publicState.className = `public-state ${publicKind}-state`;
    elements.publicState.innerHTML = `<span class="status-dot ${publicKind}${publicKind !== "up" ? " pulse" : ""}"></span><strong>${stage.publicTitle}</strong>`;
    elements.publicMonitorStatus.textContent = stage.publicStatus;
    if (elements.publicBrandDot) elements.publicBrandDot.className = `status-dot ${publicKind}`;

    const emailKind = stateClass(stage.state);
    elements.emailTitle.textContent = stage.emailTitle;
    elements.emailCopy.textContent = stage.emailCopy;
    elements.emailState.textContent = stage.emailState;
    const emailDot = $(".status-dot", elements.emailCard);
    emailDot.className = `status-dot ${emailKind}${emailKind !== "up" ? " pulse" : ""}`;

    if (lastEmailKey && lastEmailKey !== stage.emailTitle && !prefersReducedMotion()) {
      elements.emailCard.classList.remove("email-pop");
      void elements.emailCard.offsetWidth;
      elements.emailCard.classList.add("email-pop");
    }
    lastEmailKey = stage.emailTitle;

    const overlap = $("#overlap-card");
    if (overlap) overlap.hidden = demo.stage < 2;
  }

  function renderStatusPage() {
    const publicKind = demo.stage === 2 ? "down" : demo.stage === 3 ? "verifying" : "up";
    const bannerLabel = demo.stage === 2 ? "Major Outage" : demo.stage === 3 ? "Investigating" : "All Systems Operational";
    const banner = $("#sp-banner");
    banner.className = `sp-banner ${publicKind}-state`;
    banner.innerHTML = `<span class="status-dot ${publicKind}${publicKind !== "up" ? " pulse" : ""}"></span><strong>${bannerLabel}</strong>`;

    const incident = $("#sp-incident");
    const incidentOpen = demo.stage === 2 || demo.stage === 3;
    incident.hidden = !incidentOpen;
    if (incidentOpen) $("#sp-incident-duration").textContent = demo.stage === 2 ? "42s" : "1m 24s";

    $("#sp-monitors").innerHTML = demo.monitors.map((monitor, index) => {
      const view = monitorRowView(monitor, index);
      return `
        <div class="sp-row">
          <span class="sp-row-name"><span class="status-dot ${stateClass(view.state)}"></span><span>${escapeHtml(monitor.name)}</span></span>
          <div class="mini-timeline" aria-label="${escapeHtml(monitor.name)}, 90-day availability">${makeTimeline(view.state, 40, view.live, view.history)}</div>
          <span class="sp-row-uptime mono">${view.uptime}</span>
        </div>`;
    }).join("");

    $("#sp-recent").innerHTML = demo.stage === 4
      ? '<div class="sp-recent-row"><span class="sp-row-name"><span class="status-dot"></span><span>API</span></span><time class="mono">12:04 UTC</time><span class="mono">2m 08s</span></div>'
      : '<div class="sp-empty"><span class="status-dot up"></span><span>No recent incidents</span></div>';

    $("#sp-updated").textContent = `Last updated ${new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" })} UTC`;
  }

  const DEP_CATALOG = [
    { id: "openai_api", name: "OpenAI API", provider: "OpenAI", icon: "openai", group: "AI", popular: true },
    { id: "chatgpt", name: "ChatGPT", provider: "OpenAI", icon: "openai", group: "AI" },
    { id: "anthropic_api", name: "Anthropic API", provider: "Anthropic", icon: "anthropic", group: "AI", popular: true },
    { id: "google_vertex_gemini", name: "Vertex Gemini API", provider: "Google Cloud", icon: "googlecloud", group: "AI" },
    { id: "vercel_runtime", name: "Vercel Runtime", provider: "Vercel", icon: "vercel", group: "Hosting", popular: true },
    { id: "vercel_deployments", name: "Vercel Deployments", provider: "Vercel", icon: "vercel", group: "Hosting" },
    { id: "cloudflare_cdn", name: "Cloudflare CDN", provider: "Cloudflare", icon: "cloudflare", group: "Hosting", popular: true },
    { id: "cloudflare_workers", name: "Cloudflare Workers", provider: "Cloudflare", icon: "cloudflare", group: "Hosting" },
    { id: "google_cloud_run", name: "Google Cloud Run", provider: "Google Cloud", icon: "googlecloud", group: "Hosting" },
    { id: "google_cloud_sql", name: "Google Cloud SQL", provider: "Google Cloud", icon: "googlecloud", group: "Hosting" },
    { id: "google_cloud_storage", name: "Google Cloud Storage", provider: "Google Cloud", icon: "googlecloud", group: "Hosting" },
    { id: "workos_authkit", name: "WorkOS AuthKit", provider: "WorkOS", icon: "workos", group: "Auth" },
    { id: "workos_sso", name: "WorkOS SSO", provider: "WorkOS", icon: "workos", group: "Auth" },
    { id: "workos_directory_sync", name: "WorkOS Directory Sync", provider: "WorkOS", icon: "workos", group: "Auth" },
    { id: "clerk_authentication", name: "Clerk Authentication", provider: "Clerk", icon: "clerk", group: "Auth" },
    { id: "clerk_machine_auth", name: "Clerk Machine Authentication", provider: "Clerk", icon: "clerk", group: "Auth" },
    { id: "neon_database", name: "Neon Database", provider: "Neon", icon: "neon", group: "Data", region: "us-east-1", dataDefault: true },
    { id: "supabase_database", name: "Supabase Database", provider: "Supabase", icon: "supabase", group: "Data", dataDefault: true },
    { id: "supabase_auth", name: "Supabase Authentication", provider: "Supabase", icon: "supabase", group: "Data" },
    { id: "upstash_redis", name: "Upstash Redis Global", provider: "Upstash", icon: "upstash", group: "Data", dataDefault: true },
    { id: "upstash_redis_regional", name: "Upstash Redis Regional", provider: "Upstash", icon: "upstash", group: "Data", region: "us-east-1" },
    { id: "stripe_api", name: "Stripe API", provider: "Stripe", icon: "stripe", group: "Payments", popular: true },
    { id: "stripe_checkout", name: "Stripe Checkout", provider: "Stripe", icon: "stripe", group: "Payments" },
    { id: "stripe_webhooks", name: "Stripe Webhooks", provider: "Stripe", icon: "stripe", group: "Payments" },
    { id: "resend_email_sending", name: "Resend Email Sending", provider: "Resend", icon: "resend", group: "Payments" },
    { id: "resend_webhooks", name: "Resend Webhooks", provider: "Resend", icon: "resend", group: "Payments" },
    { id: "postmark_email_delivery", name: "Postmark Email Delivery", provider: "Postmark", icon: "postmark", group: "Payments" },
    { id: "twilio_messaging", name: "Twilio Messaging", provider: "Twilio", icon: "twilio", group: "Payments" },
    { id: "github_api", name: "GitHub API", provider: "GitHub", icon: "github", group: "Developer" },
    { id: "github_actions", name: "GitHub Actions", provider: "GitHub", icon: "github", group: "Developer" }
  ];

  const DEP_GROUP_ORDER = ["AI", "Hosting", "Auth", "Data", "Payments", "Developer"];

  const DEP_PROVIDERS = [
    ["OpenAI", "openai"], ["Anthropic", "anthropic"], ["Google Cloud", "googlecloud"],
    ["Vercel", "vercel"], ["Cloudflare", "cloudflare"], ["WorkOS", "workos"],
    ["Clerk", "clerk"], ["Neon", "neon"], ["Supabase", "supabase"],
    ["Upstash", "upstash"], ["Stripe", "stripe"], ["Resend", "resend"],
    ["Postmark", "postmark"], ["Twilio", "twilio"], ["GitHub", "github"]
  ];

  const DEP_STATE_META = {
    OPERATIONAL: { label: "Operational", dot: "up" },
    DEGRADED: { label: "Degraded", dot: "verifying" },
    OUTAGE: { label: "Outage", dot: "down" },
    MAINTENANCE: { label: "Maintenance", dot: "neutral" },
    UNKNOWN: { label: "Unknown", dot: "neutral" }
  };

  const DEP_ICONS_FULL = {
    neon: {
      vb: "0 0 64 64",
      body: '<path fill="currentColor" d="M63 0.0177909V63.5526L38.4178 42.2501V63.5526H0V0L63 0.0177909ZM7.72251 55.8389H30.6953V25.3238L55.2779 47.0476V7.72922L7.72251 7.71559V55.8389Z"/>'
    },
    workos: {
      vb: "0 0 55.4 48",
      body: '<path fill="currentColor" d="M0,24c0,1.1,0.3,2.1,0.8,3l9.7,16.8c1,1.7,2.5,3.1,4.4,3.7c3.6,1.2,7.5-0.3,9.4-3.5l2.3-4.1l-9.2-16l9.8-16.9L29.5,3c0.7-1.2,1.6-2.2,2.7-3H17.2c-2.6,0-5.1,1.4-6.4,3.7L0.8,21C0.3,21.9,0,22.9,0,24z"/><path fill="currentColor" d="M55.4,24c0-1.1-0.3-2.1-0.8-3l-9.8-17c-1.9-3.3-5.8-4.7-9.4-3.5c-1.9,0.6-3.4,2-4.4,3.7L28.7,8L38,24l-9.8,16.9L25.9,45c-0.7,1.2-1.6,2.2-2.7,3h15.1c2.6,0,5.1-1.4,6.4-3.7l10-17.3C55.1,26.1,55.4,25.1,55.4,24z"/>'
    },
    postmark: {
      vb: "0 0 30 30",
      body: '<path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M30 27.4219V28.8281C29.3528 28.8281 28.8281 29.3528 28.8281 30H27.4219C27.4219 29.3528 26.8972 28.8281 26.25 28.8281C25.6028 28.8281 25.0781 29.3528 25.0781 30H23.6719C23.6719 29.3528 23.1472 28.8281 22.5 28.8281C21.8528 28.8281 21.3281 29.3528 21.3281 30H19.9219C19.9219 29.3528 19.3972 28.8281 18.75 28.8281C18.1028 28.8281 17.5781 29.3528 17.5781 30H16.1719C16.1719 29.3528 15.6472 28.8281 15 28.8281C14.3528 28.8281 13.8281 29.3528 13.8281 30H12.4219C12.4219 29.3528 11.8972 28.8281 11.25 28.8281C10.6028 28.8281 10.0781 29.3528 10.0781 30H8.67188C8.67188 29.3528 8.14721 28.8281 7.5 28.8281C6.85279 28.8281 6.32812 29.3528 6.32812 30H4.92188C4.92188 29.5813 4.69852 29.1945 4.33594 28.9851C3.97336 28.7758 3.52664 28.7758 3.16406 28.9851C2.80148 29.1945 2.57812 29.5813 2.57812 30H1.17188C1.17188 29.3528 0.647209 28.8281 0 28.8281V27.4219C0.647209 27.4219 1.17188 26.8972 1.17188 26.25C1.17188 25.6028 0.647209 25.0781 0 25.0781V23.6719C0.647209 23.6719 1.17188 23.1472 1.17188 22.5C1.17188 21.8528 0.647209 21.3281 0 21.3281V19.9219C0.647209 19.9219 1.17188 19.3972 1.17188 18.75C1.17188 18.1028 0.647209 17.5781 0 17.5781V16.1719C0.647209 16.1719 1.17188 15.6472 1.17188 15C1.17188 14.3528 0.647209 13.8281 0 13.8281V12.4219C0.647209 12.4219 1.17188 11.8972 1.17188 11.25C1.17188 10.6028 0.647209 10.0781 0 10.0781V8.67188C0.647209 8.67188 1.17188 8.14721 1.17188 7.5C1.17188 6.85279 0.647209 6.32812 0 6.32812V4.92188C0.647209 4.92187 1.17188 4.39721 1.17188 3.75C1.17188 3.10279 0.647209 2.57813 0 2.57812V1.17188C0.647209 1.17188 1.17188 0.647209 1.17188 0H2.57812C2.57813 0.647209 3.10279 1.17188 3.75 1.17188C4.39721 1.17188 4.92187 0.647209 4.92188 0H6.32812C6.32812 0.647209 6.85279 1.17188 7.5 1.17188C8.14721 1.17188 8.67188 0.647209 8.67188 0H10.0781C10.0781 0.647209 10.6028 1.17188 11.25 1.17188C11.8972 1.17188 12.4219 0.647209 12.4219 0H13.8281C13.8281 0.647209 14.3528 1.17188 15 1.17188C15.6472 1.17188 16.1719 0.647209 16.1719 0H17.5781C17.5781 0.647209 18.1028 1.17188 18.75 1.17188C19.3972 1.17188 19.9219 0.647209 19.9219 0H21.3281C21.3281 0.647209 21.8528 1.17188 22.5 1.17188C23.1472 1.17188 23.6719 0.647209 23.6719 0H25.0781C25.0781 0.647209 25.6028 1.17188 26.25 1.17188C26.8972 1.17188 27.4219 0.647209 27.4219 0H28.8281C28.8281 0.647209 29.3528 1.17188 30 1.17188V2.57812C29.3528 2.57812 28.8281 3.10279 28.8281 3.75C28.8281 4.39721 29.3528 4.92188 30 4.92188V6.32812C29.3528 6.32812 28.8281 6.85279 28.8281 7.5C28.8281 8.14721 29.3528 8.67188 30 8.67188V10.0781C29.3528 10.0781 28.8281 10.6028 28.8281 11.25C28.8281 11.8972 29.3528 12.4219 30 12.4219V13.8281C29.5813 13.8281 29.1945 14.0515 28.9851 14.4141C28.7758 14.7766 28.7758 15.2234 28.9851 15.5859C29.1945 15.9485 29.5813 16.1719 30 16.1719V17.5781C29.3528 17.5781 28.8281 18.1028 28.8281 18.75C28.8281 19.3972 29.3528 19.9219 30 19.9219V21.3281C29.3528 21.3281 28.8281 21.8528 28.8281 22.5C28.8281 23.1472 29.3528 23.6719 30 23.6719V25.0781C29.3528 25.0781 28.8281 25.6028 28.8281 26.25C28.8281 26.8972 29.3528 27.4219 30 27.4219V27.4219Z"/><path fill="var(--bg)" d="M8.70312 21.3804H9.63846C10.1188 21.3804 10.4221 21.0705 10.4221 20.5798V9.62885C10.4221 9.13812 10.1188 8.82819 9.63846 8.82819H8.70312V6.40039H15.478C19.1182 6.40039 22 8.28581 22 11.8759C22 15.4917 19.1182 17.3772 15.478 17.3772H13.1523V20.5798C13.1523 21.0705 13.4556 21.3804 13.9612 21.3804H15.8571V23.8341H8.70312V21.3804ZM15.2757 14.846C17.6773 14.846 19.0676 13.8129 19.0676 11.9275C19.0676 9.99044 17.6773 9.00899 15.2757 9.00899H13.1523V14.8719H15.2757V14.846Z"/>'
    }
  };

  function depIcon(iconSlug, monogram) {
    const full = iconSlug ? DEP_ICONS_FULL[iconSlug] : null;
    if (full) return `<svg class="dep-mark" viewBox="${full.vb}" aria-hidden="true">${full.body}</svg>`;
    const path = iconSlug ? DEP_ICONS[iconSlug] : null;
    if (path) return `<svg class="dep-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
    return `<span class="dep-mark dep-mark-mono" aria-hidden="true">${escapeHtml(monogram || "?")}</span>`;
  }

  function dependencyState(dep) {
    if (dep.id === "vercel_runtime" && (demo.stage === 2 || demo.stage === 3)) {
      return { state: "OUTAGE", incident: "Elevated errors in iad1" };
    }
    return { state: "OPERATIONAL", incident: null };
  }

  function depTimeline(dep, count) {
    return Array.from({ length: count }, (_, index) => {
      let cls = "up";
      if (dep.fresh && index < count - 3) cls = "";
      if (dep.id === "vercel_runtime" && demo.stage >= 2 && index >= count - 2) {
        cls = demo.stage === 4 && index === count - 1 ? "up" : "down";
      }
      return `<span class="timeline-segment ${cls}" aria-hidden="true"></span>`;
    }).join("");
  }

  function renderDependencies() {
    const container = $("#dependency-rows");
    if (!container) return;
    container.innerHTML = demo.dependencies.map((dep) => {
      const item = DEP_CATALOG.find((entry) => entry.id === dep.id);
      const status = dependencyState(dep);
      const meta = DEP_STATE_META[status.state];
      const pulse = meta.dot === "down" ? " pulse" : "";
      return `
        <div class="dep-row${dep.fresh ? " row-enter" : ""}">
          <span class="dep-status"><span class="status-dot ${meta.dot}${pulse}"></span>${meta.label}</span>
          <span class="dep-name">${depIcon(item.icon, item.monogram)}<span class="dep-name-text"><strong>${escapeHtml(item.name)}${dep.region ? ` · ${escapeHtml(dep.region)}` : ""}</strong><small>${escapeHtml(item.provider)}</small></span></span>
          <div class="mini-timeline dep-timeline" aria-label="${escapeHtml(item.name)} provider-reported timeline">${depTimeline(dep, 22)}</div>
          <span class="dep-incident mono">${status.incident ? escapeHtml(status.incident) : "—"}</span>
        </div>`;
    }).join("");
  }

  function renderDepCatalog(filter) {
    const container = $("#dep-catalog");
    if (!container) return;
    const query = (filter || "").trim().toLowerCase();
    let sections;
    if (!query) {
      sections = [
        ["Popular", DEP_CATALOG.filter((item) => item.popular)],
        ["Data", DEP_CATALOG.filter((item) => item.dataDefault)]
      ];
    } else {
      const matches = DEP_CATALOG.filter((item) =>
        `${item.name} ${item.provider} ${item.group}`.toLowerCase().includes(query));
      sections = DEP_GROUP_ORDER
        .map((group) => [group, matches.filter((item) => item.group === group)])
        .filter(([, items]) => items.length);
    }
    container.innerHTML = sections.map(([group, items]) => {
      if (!items.length) return "";
      return `<p class="dep-group">${group}</p>` + items.map((item) => {
        const installed = demo.dependencies.some((dep) => dep.id === item.id);
        return `
          <div class="dep-catalog-row">
            ${depIcon(item.icon, item.monogram)}
            <span class="dep-catalog-name">${escapeHtml(item.name)}</span>
            ${item.region ? `<span class="dep-region mono">${escapeHtml(item.region)}</span>` : ""}
            <button class="copy-button dep-add" type="button" data-dep="${item.id}" ${installed ? "disabled" : ""}>${installed ? "Added" : "Add"}</button>
          </div>`;
      }).join("");
    }).join("") || '<p class="dep-empty">No matching service</p>';

    $$(".dep-add", container).forEach((button) => button.addEventListener("click", () => {
      const item = DEP_CATALOG.find((entry) => entry.id === button.dataset.dep);
      if (!item || demo.dependencies.some((dep) => dep.id === item.id)) return;
      demo.dependencies.push({ id: item.id, region: item.region || null, fresh: true });
      renderDepCatalog($("#dep-search")?.value || "");
      renderDependencies();
      renderCLI(false);
      showToast(`${item.name} added`);
    }));
  }

  function renderLogoStrip() {
    const strip = $("#logo-strip");
    if (!strip) return;
    const items = DEP_PROVIDERS.map(([name, icon, monogram]) =>
      `<span class="logo-item">${depIcon(icon, monogram)}${escapeHtml(name)}</span>`).join("");
    strip.innerHTML = `<div class="logo-track" aria-hidden="false">${items}${items}</div>`;
  }

  function cliData() {
    const incidentStatus = demo.stage >= 2 && demo.stage < 4 ? "ONGOING" : demo.stage === 4 ? "RESOLVED" : "NONE";

    if (demo.command === "me") {
      if (demo.output === "json") {
        return JSON.stringify({ user: "you@example.com", deployment: "pulse.example.com", authenticated: true }, null, 2);
      }
      return [
        "USER              DEPLOYMENT          AUTH",
        "you@example.com   pulse.example.com   linked"
      ].join("\n");
    }

    if (demo.command === "monitors") {
      if (demo.output === "json") {
        return JSON.stringify(demo.monitors.map((monitor, index) => {
          const view = monitorRowView(monitor, index);
          return {
            name: monitor.name,
            url: monitor.url,
            state: view.state,
            latency_ms: view.latency,
            uptime_24h: view.uptime
          };
        }), null, 2);
      }
      const rows = demo.monitors.map((monitor, index) => {
        const view = monitorRowView(monitor, index);
        const latency = view.latency === null ? "—" : `${view.latency}ms`;
        return `${monitor.name.padEnd(14)} ${statusLabel(view.state).toUpperCase().padEnd(11)} ${latency.padEnd(9)} ${view.uptime}`;
      });
      return ["MONITOR        STATUS      LATENCY   UPTIME", ...rows].join("\n");
    }

    if (demo.command === "deps") {
      const rows = demo.dependencies.map((dep) => {
        const item = DEP_CATALOG.find((entry) => entry.id === dep.id);
        const status = dependencyState(dep);
        const name = dep.region ? `${item.name} ${dep.region}` : item.name;
        return { name, provider: item.provider, state: status.state };
      });
      if (demo.output === "json") {
        return JSON.stringify(rows.map((row) => ({ name: row.name, provider: row.provider, state: row.state, source: "provider_reported" })), null, 2);
      }
      return ["DEPENDENCY               PROVIDER     STATE", ...rows.map((row) =>
        `${row.name.padEnd(24)} ${row.provider.padEnd(12)} ${row.state}`)].join("\n");
    }

    const duration = demo.stage === 2 ? "42s" : demo.stage === 3 ? "1m24s" : demo.stage === 4 ? "2m08s" : null;
    if (demo.output === "json") {
      return JSON.stringify({ monitor: "API", status: incidentStatus, cause: demo.stage >= 2 ? "TIMEOUT" : null, duration }, null, 2);
    }
    return [
      "MONITOR        STATUS      CAUSE      DURATION",
      `API            ${incidentStatus.padEnd(11)} ${(demo.stage >= 2 ? "TIMEOUT" : "—").padEnd(10)} ${duration ?? "—"}`
    ].join("\n");
  }

  function decorateOutput(text) {
    return escapeHtml(text)
      .replace(/\bUP\b/g, '<span class="t-up">UP</span>')
      .replace(/\bDOWN\b/g, '<span class="t-down">DOWN</span>')
      .replace(/\bVERIFYING\b/g, '<span class="t-verifying">VERIFYING</span>')
      .replace(/\bPENDING\b/g, '<span class="t-muted">PENDING</span>')
      .replace(/\bONGOING\b/g, '<span class="t-down">ONGOING</span>')
      .replace(/\bRESOLVED\b/g, '<span class="t-up">RESOLVED</span>')
      .replace(/\blinked\b/g, '<span class="t-up">linked</span>')
      .replace(/\bOPERATIONAL\b/g, '<span class="t-up">OPERATIONAL</span>')
      .replace(/\bOUTAGE\b/g, '<span class="t-down">OUTAGE</span>')
      .replace(/\bDEGRADED\b/g, '<span class="t-verifying">DEGRADED</span>')
      .replace(/\bUNKNOWN\b/g, '<span class="t-muted">UNKNOWN</span>')
      .replace(/\bNONE\b/g, '<span class="t-muted">NONE</span>');
  }

  function printCLI(command) {
    elements.terminalOutput.innerHTML = `<span class="t-prompt">$</span> ${escapeHtml(command)}\n\n${decorateOutput(cliData())}\n`;
  }

  let typeTimer = 0;

  function renderCLI(animate) {
    const command = commandValue();
    elements.copyCommand.dataset.copyValue = command;
    $$(".command").forEach((button) => button.classList.toggle("active", button.dataset.command === demo.command));
    $$("[data-output]").forEach((button) => button.classList.toggle("active", button.dataset.output === demo.output));

    window.clearInterval(typeTimer);
    if (!animate || prefersReducedMotion()) {
      printCLI(command);
      return;
    }

    let visible = 0;
    const type = () => {
      elements.terminalOutput.innerHTML = `<span class="t-prompt">$</span> ${escapeHtml(command.slice(0, visible))}<span class="terminal-cursor" aria-hidden="true"></span>`;
    };
    type();
    typeTimer = window.setInterval(() => {
      visible += 1;
      if (visible > command.length) {
        window.clearInterval(typeTimer);
        printCLI(command);
        return;
      }
      type();
    }, 16);
  }

  function commandValue() {
    if (demo.command === "me") return "pulsectl me";
    if (demo.command === "monitors") return demo.output === "json" ? "pulsectl monitor list --output json" : "pulsectl monitor list";
    if (demo.command === "deps") return demo.output === "json" ? "pulsectl dependency list --output json" : "pulsectl dependency list";
    return demo.output === "json" ? "pulsectl incident list --output json" : "pulsectl incident list";
  }

  function renderAll() {
    renderMonitors();
    renderSimulation();
    renderIncident();
    renderStatusPage();
    renderDependencies();
    renderCLI(false);
  }

  function setStage(nextStage) {
    demo.stage = Math.max(0, Math.min(4, nextStage));
    renderAll();
  }

  function addMonitor(form) {
    const values = new FormData(form);
    const name = String(values.get("name") || "Monitor").trim();
    const url = String(values.get("url") || "").trim();
    if (!name || !url) return;

    const id = `monitor-${Date.now()}`;
    demo.monitors.push({
      id,
      name,
      url,
      uptime: "—",
      latency: null,
      status: "PENDING",
      checked: "Pending",
      custom: true,
      addedAt: Date.now(),
      lastCheckAt: null,
      history: 0
    });
    demo.lastAdded = id;
    renderMonitors();
    showToast("Monitor created — running first check");
    ensureMonitorTicker();
  }

  let monitorTicker = 0;

  function ensureMonitorTicker() {
    if (monitorTicker) return;
    monitorTicker = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      demo.monitors.forEach((monitor) => {
        if (!monitor.custom) return;
        if (monitor.status === "PENDING" && now - monitor.addedAt > 1800) {
          monitor.status = "UP";
          monitor.latency = 24 + Math.round(Math.random() * 70);
          monitor.uptime = "100%";
          monitor.lastCheckAt = now;
          monitor.history = 1;
          showToast(`${monitor.name} is up — first check passed`);
          changed = true;
        } else if (monitor.status === "UP" && now - monitor.lastCheckAt >= 12000) {
          monitor.latency = Math.max(12, monitor.latency + Math.round(Math.random() * 14 - 7));
          monitor.lastCheckAt = now;
          monitor.history += 1;
          changed = true;
        }
        if (monitor.lastCheckAt) {
          const seconds = Math.round((now - monitor.lastCheckAt) / 1000);
          monitor.checked = seconds < 4 ? "Just now" : `${seconds}s ago`;
          changed = true;
        }
      });
      if (changed) {
        renderMonitors();
        renderStatusPage();
      }
    }, 3000);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showToast(message) {
    elements.toast.innerHTML = `<span class="status-dot up" aria-hidden="true"></span>${escapeHtml(message)}`;
    elements.toast.classList.add("visible");
    window.clearTimeout(showToast.timeout);
    showToast.timeout = window.setTimeout(() => elements.toast.classList.remove("visible"), 1800);
  }

  function preferredScrollBehavior() {
    return prefersReducedMotion() ? "auto" : "smooth";
  }

  const copyTimers = new WeakMap();
  const copyLabels = new WeakMap();

  async function copyText(value, button) {
    try {
      await navigator.clipboard.writeText(value);
      if (!button) {
        showToast("Copied to clipboard");
        return;
      }
      if (!copyLabels.has(button)) copyLabels.set(button, button.innerHTML);
      button.classList.add("success");
      button.innerHTML = `${CHECK_ICON}Copied`;
      showToast("Copied to clipboard");
      window.clearTimeout(copyTimers.get(button));
      copyTimers.set(button, window.setTimeout(() => {
        button.classList.remove("success");
        button.innerHTML = copyLabels.get(button);
      }, 1400));
    } catch {
      showToast("Copy unavailable");
    }
  }

  function setTheme(theme) {
    demo.theme = theme;
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("pulse-marketing-theme", theme);
    } catch {
      /* private mode */
    }
    const next = theme === "dark" ? "light" : "dark";
    elements.themeToggle.setAttribute("aria-label", `Use ${next} theme`);
    elements.themeToggle.dataset.tooltip = `${next[0].toUpperCase()}${next.slice(1)} theme`;
  }

  function renderDatabase(value) {
    const percentage = Number(value);
    let health = "Healthy";
    let mode = "Full detail";
    let action = "None required";
    let minuteRetention = "48 hours";
    let hourlyRetention = "30 days";

    if (percentage >= 95) {
      health = "Critical";
      mode = "Preserve essentials";
      action = "Keep incidents and daily rollups";
      minuteRetention = "Current state only";
      hourlyRetention = "Incident windows";
    } else if (percentage >= 85) {
      health = "Protecting";
      mode = "Protecting history";
      action = "Shrink fine-grained retention";
      minuteRetention = "12 hours";
      hourlyRetention = "Incident windows";
    } else if (percentage >= 75) {
      health = "Optimizing";
      mode = "Accelerated compaction";
      action = "Compact completed buckets early";
      minuteRetention = "24 hours";
      hourlyRetention = "21 days";
    } else if (percentage >= 60) {
      health = "Watching";
      mode = "Watching growth";
      action = "Review projected growth daily";
    }

    const healthClass = health.toLowerCase();
    $("#storage-value").textContent = `${Math.round(percentage * 5)} MB`;
    $("#storage-percent").textContent = `${percentage}%`;
    $("#storage-fill").style.width = `${percentage}%`;
    $("#storage-fill").className = healthClass;
    $("#db-health-title").textContent = health;
    $("#db-health-copy").textContent = health === "Healthy" ? "Storage remains within its configured budget" : `${mode} keeps high-value history available`;
    $("#db-health-label").textContent = health;
    $("#db-health-label").className = `health-label ${healthClass}`;
    $("#governor-mode").textContent = mode;
    $("#governor-action").textContent = action;
    $("#minute-retention").textContent = minuteRetention;
    $("#hourly-retention").textContent = hourlyRetention;

    const totalMB = Math.round(percentage * 5);
    [["rollups", 0.53], ["exceptions", 0.15], ["incidents", 0.08], ["recent", 0.03], ["core", 0.21]].forEach(([key, share]) => {
      const row = $(`[data-breakdown="${key}"]`);
      if (!row) return;
      const mb = Math.max(1, Math.round(totalMB * share));
      $(".bar i", row).style.width = `${Math.min(100, (mb / 500) * 180).toFixed(1)}%`;
      $(".value-mb", row).textContent = `${mb} MB`;
      $(".value-pct", row).textContent = `${Math.round(share * 100)}%`;
    });
  }

  let playTimer = 0;

  function stopPlayback() {
    if (!playTimer) return;
    window.clearInterval(playTimer);
    playTimer = 0;
    elements.playButton.classList.remove("playing");
    elements.playLabel.textContent = "Play";
    elements.playButton.setAttribute("aria-label", "Play demo");
  }

  function startPlayback() {
    if (demo.stage >= 4) setStage(0);
    elements.playButton.classList.add("playing");
    elements.playLabel.textContent = "Pause";
    elements.playButton.setAttribute("aria-label", "Pause demo");
    playTimer = window.setInterval(() => {
      setStage(demo.stage + 1);
      if (demo.stage >= 4) stopPlayback();
    }, 1600);
    renderSimulation();
  }

  elements.playButton.addEventListener("click", () => (playTimer ? stopPlayback() : startPlayback()));
  elements.stepBack.addEventListener("click", () => {
    stopPlayback();
    setStage(demo.stage - 1);
  });
  elements.stepForward.addEventListener("click", () => {
    stopPlayback();
    setStage(demo.stage === 4 ? 0 : demo.stage + 1);
  });
  $$("[data-scroll-to]").forEach((button) => {
    button.addEventListener("click", () => {
      $(`#${button.dataset.scrollTo}`)?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" });
    });
  });

  $$("[data-open-monitor]").forEach((button) => button.addEventListener("click", () => elements.dialog.showModal()));
  $$("[data-close-monitor]").forEach((button) => button.addEventListener("click", () => elements.dialog.close()));
  elements.dialog.addEventListener("click", (event) => {
    if (event.target === elements.dialog) elements.dialog.close();
  });

  const palette = $("#command-palette");
  const paletteInput = $("#palette-input");
  const paletteList = $("#palette-list");
  let paletteMatches = [];
  let paletteIndex = 0;

  const goTo = (selector) => $(selector)?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" });

  const PALETTE_COMMANDS = [
    { label: "New monitor", hint: "dashboard", run: () => elements.dialog.showModal() },
    { label: "Play the outage demo", hint: "detect", run: () => { goTo("#simulation"); startPlayback(); } },
    { label: "Reset demo", hint: "detect", run: () => { stopPlayback(); setStage(0); goTo("#simulation"); } },
    { label: "Run pulsectl me", hint: "cli", run: () => { demo.command = "me"; goTo("#cli"); renderCLI(true); } },
    { label: "Run pulsectl monitor list", hint: "cli", run: () => { demo.command = "monitors"; goTo("#cli"); renderCLI(true); } },
    { label: "Run pulsectl incident list", hint: "cli", run: () => { demo.command = "incidents"; goTo("#cli"); renderCLI(true); } },
    { label: "Add a dependency", hint: "attribute", run: () => goTo("#dependencies") },
    { label: "Run pulsectl dependency list", hint: "cli", run: () => { demo.command = "deps"; goTo("#cli"); renderCLI(true); } },
    { label: "Copy agent prompt", hint: "agents", run: () => copyText($("#agent-prompt code").textContent.trim()) },
    { label: "Toggle theme", hint: "appearance", run: () => setTheme(demo.theme === "dark" ? "light" : "dark") },
    { label: "View architecture", hint: "navigate", run: () => goTo("#architecture") },
    { label: "View status page", hint: "navigate", run: () => goTo("#status-page") },
    { label: "Deploy Pulse", hint: "navigate", run: () => goTo("#deploy") }
  ];

  function highlightPalette() {
    $$(".palette-item", paletteList).forEach((item) => {
      const selected = Number(item.dataset.index) === paletteIndex;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-selected", String(selected));
      if (selected) item.scrollIntoView({ block: "nearest" });
    });
  }

  function renderPalette(filter) {
    const query = filter.trim().toLowerCase();
    paletteMatches = PALETTE_COMMANDS.filter((command) => command.label.toLowerCase().includes(query));
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteMatches.length - 1));
    paletteList.innerHTML = paletteMatches.length
      ? paletteMatches.map((command, index) => `<li class="palette-item" data-index="${index}" role="option"><span>${escapeHtml(command.label)}</span><span class="hint">${escapeHtml(command.hint)}</span></li>`).join("")
      : '<li class="palette-empty">No matching command</li>';
    $$(".palette-item", paletteList).forEach((item) => {
      item.addEventListener("mouseenter", () => {
        const index = Number(item.dataset.index);
        if (index === paletteIndex) return;
        paletteIndex = index;
        highlightPalette();
      });
      item.addEventListener("click", runPaletteCommand);
    });
    highlightPalette();
  }

  function runPaletteCommand() {
    const command = paletteMatches[paletteIndex];
    if (!command) return;
    palette.close();
    window.setTimeout(() => command.run(), 30);
  }

  function openPalette() {
    if (palette.open) {
      palette.close();
      return;
    }
    paletteIndex = 0;
    paletteInput.value = "";
    renderPalette("");
    palette.showModal();
    paletteInput.focus();
  }

  paletteInput.addEventListener("input", () => {
    paletteIndex = 0;
    renderPalette(paletteInput.value);
  });

  paletteInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      paletteIndex = Math.min(paletteIndex + 1, Math.max(0, paletteMatches.length - 1));
      highlightPalette();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      paletteIndex = Math.max(paletteIndex - 1, 0);
      highlightPalette();
    } else if (event.key === "Enter") {
      event.preventDefault();
      runPaletteCommand();
    }
  });

  palette.addEventListener("click", (event) => {
    if (event.target === palette) palette.close();
  });

  $$("[data-open-palette]").forEach((button) => button.addEventListener("click", openPalette));

  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPalette();
    }
  });

  $("#inline-monitor-form").addEventListener("submit", (event) => {
    event.preventDefault();
    addMonitor(event.currentTarget);
    $("#monitor-form-note").textContent = "Monitor added to the dashboard above";
    $("#simulation").scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" });
  });

  $("#dialog-monitor-form").addEventListener("submit", (event) => {
    event.preventDefault();
    addMonitor(event.currentTarget);
    elements.dialog.close();
  });

  $$(".command").forEach((button) => button.addEventListener("click", () => {
    demo.command = button.dataset.command;
    renderCLI(true);
  }));

  $$("[data-output]").forEach((button) => button.addEventListener("click", () => {
    demo.output = button.dataset.output;
    renderCLI(true);
  }));

  elements.copyCommand.addEventListener("click", () => copyText(elements.copyCommand.dataset.copyValue, elements.copyCommand));

  const terminalInput = $("#terminal-input");
  const typedHistory = [];
  let historyIndex = -1;

  const PULSECTL_TYPED = {
    "pulsectl me": "me",
    "pulsectl monitor list": "monitors",
    "pulsectl incident list": "incidents",
    "pulsectl dependency list": "deps"
  };

  const HELP_TEXT = [
    "pulsectl me                      show linked deployment",
    "pulsectl monitor list            list monitors",
    "pulsectl incident list           list incidents",
    "pulsectl dependency list         list dependencies",
    "  add --output json to any list command",
    "",
    "clear · whoami · ls · uptime · ping · echo · date · history",
    "…and a few undocumented ones"
  ].join("\n");

  function easterEgg(cmd) {
    const lower = cmd.toLowerCase();
    if (lower === "help" || lower === "pulsectl help" || lower === "pulsectl --help" || lower === "man pulsectl") return HELP_TEXT;
    if (lower === "whoami") return "you@example.com";
    if (lower === "ls" || lower === "ls -la") return "monitors/    incidents/    dependencies/    status/";
    if (lower === "pwd") return "~/pulse";
    if (lower === "uptime") return "up 247 days · 100.00% · this page monitors itself";
    if (lower === "date") return new Date().toUTCString();
    if (lower === "history") return typedHistory.map((entry, index) => `${String(index + 1).padStart(3)}  ${entry}`).join("\n") || "no history yet";
    if (lower.startsWith("ping")) return `PONG from pulse.example.com: time=${18 + Math.round(Math.random() * 40)}ms`;
    if (lower.startsWith("echo ")) return cmd.slice(5);
    if (lower.startsWith("sudo")) return "You already own this. That's the point.";
    if (/^rm(\s|$)/.test(lower)) return "Blocked. Pulse preserves history.";
    if (lower === "vim" || lower === "vi") return ":q! You're free now.";
    if (lower === "emacs") return "M-x lighten-up";
    if (lower === "exit" || lower === "logout" || lower === "quit") return "There is no exit. Uptime is forever.";
    if (lower === "make coffee" || lower === "brew coffee") return "Error 418: I'm a teapot.";
    if (lower === "whois them") return "It was them. It's always them.";
    if (lower === "pulse") return "▁▂▄█▇▅▂▁▁▂▄█▇▅▂▁▁▂▄█▇▅▂▁  all systems nominal";
    if (lower === "pulsectl deploy") return "One prompt, live in 5 minutes. The Deploy Pulse button is right up top.";
    if (lower.startsWith("pulsectl")) return `pulsectl: unknown command\ntry: me · monitor list · incident list · dependency list`;
    return `command not found: ${cmd.split(" ")[0]}\ntry: help`;
  }

  function appendCLI(cmd, output) {
    elements.terminalOutput.innerHTML += `<span class="t-prompt">$</span> ${escapeHtml(cmd)}\n\n${decorateOutput(output)}\n\n`;
    elements.terminalOutput.scrollTop = elements.terminalOutput.scrollHeight;
  }

  function runTypedCommand(raw) {
    const cmd = raw.trim();
    if (!cmd) return;
    typedHistory.push(cmd);
    historyIndex = typedHistory.length;

    if (cmd.toLowerCase() === "clear") {
      elements.terminalOutput.innerHTML = "";
      return;
    }

    const lower = cmd.toLowerCase();
    const wantsJson = /\s--output\s+json$/.test(lower);
    const base = lower.replace(/\s--output\s+json$/, "").replace(/\s+/g, " ");

    if (PULSECTL_TYPED[base]) {
      demo.command = PULSECTL_TYPED[base];
      if (wantsJson) demo.output = "json";
      $$(".command").forEach((button) => button.classList.toggle("active", button.dataset.command === demo.command));
      $$("[data-output]").forEach((button) => button.classList.toggle("active", button.dataset.output === demo.output));
      elements.copyCommand.dataset.copyValue = commandValue();
      appendCLI(cmd, cliData());
      return;
    }

    appendCLI(cmd, easterEgg(cmd));
  }

  if (terminalInput) {
    terminalInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runTypedCommand(terminalInput.value);
        terminalInput.value = "";
      } else if (event.key === "ArrowUp") {
        if (!typedHistory.length) return;
        event.preventDefault();
        historyIndex = Math.max(0, historyIndex - 1);
        terminalInput.value = typedHistory[historyIndex] || "";
      } else if (event.key === "ArrowDown") {
        if (!typedHistory.length) return;
        event.preventDefault();
        historyIndex = Math.min(typedHistory.length, historyIndex + 1);
        terminalInput.value = typedHistory[historyIndex] || "";
      }
    });

    $(".terminal-body").addEventListener("click", (event) => {
      if (event.target.closest("button, input, a")) return;
      terminalInput.focus({ preventScroll: true });
    });
  }

  $$("[data-copy-target]").forEach((button) => button.addEventListener("click", () => {
    const target = $(`#${button.dataset.copyTarget} code`);
    copyText(target.textContent.trim(), button);
  }));

  function positionRangeTooltip() {
    const wrap = $(".range-wrap");
    const range = $("#storage-range");
    if (!wrap || !range || !range.clientWidth) return;
    const progress = (range.value - range.min) / (range.max - range.min);
    const x = 8 + progress * (range.clientWidth - 16);
    wrap.style.setProperty("--thumb-x", `${Math.round(x)}px`);
  }

  $("#storage-range").addEventListener("input", (event) => {
    renderDatabase(event.currentTarget.value);
    positionRangeTooltip();
  });
  window.addEventListener("resize", positionRangeTooltip);
  positionRangeTooltip();

  const SYSTEM_DETAILS = {
    cron: {
      kicker: "01 · Scheduler",
      title: "Vercel Cron",
      copy: "Fires once per minute and hands Pulse a single packed batch of due checks. No worker fleet, no queue to babysit. Every monitor keeps its own configurable interval, from one minute up.",
      stats: [["Cadence", "1 run / min"], ["Intervals", "1 · 5 · 15 min"], ["Idle compute", "None"]],
      flow: "Vercel Cron → Pulse",
      visual: `
        <div class="dv-frame">
          <div class="dv-head"><span>pulse-uptime · logs</span><span class="dv-live"><span class="status-dot up pulse"></span>Live</span></div>
          <div class="dv-rows">
            <div class="dv-row"><time>12:04:00.21</time><span class="dv-ok">200</span><span class="dv-path">/api/cron/check-monitors</span><span class="dv-msg">cron.completed · 3 checks</span></div>
            <div class="dv-row"><time>12:04:00.19</time><span class="dv-ok">200</span><span class="dv-path">/api/cron/check-dependencies</span><span class="dv-msg">3 sources · 304</span></div>
            <div class="dv-row"><time>12:03:00.24</time><span class="dv-ok">200</span><span class="dv-path">/api/cron/check-monitors</span><span class="dv-msg">cron.completed · 3 checks</span></div>
            <div class="dv-row"><time>12:02:00.18</time><span class="dv-ok">200</span><span class="dv-path">/api/cron/check-monitors</span><span class="dv-msg">cron.completed · 3 checks</span></div>
            <div class="dv-row"><time>12:01:00.22</time><span class="dv-ok">200</span><span class="dv-path">/api/cron/check-monitors</span><span class="dv-msg">cron.completed · 3 checks</span></div>
          </div>
        </div>`
    },
    pulse: {
      kicker: "02 · Control plane",
      title: "Pulse",
      copy: "Runs every check, resolves state transitions, opens and closes incidents, and serves the dashboard, API, and CLI from one deployment.",
      stats: [["Checks", "HTTP + latency"], ["States", "Up · Verifying · Down"], ["Interfaces", "UI · API · CLI"]],
      flow: "Vercel Cron → Pulse → Neon · Edge Config · Resend",
      visual: `
        <div class="dv-duo">
          <div class="dv-frame dv-browser">
            <div class="dv-head"><span class="terminal-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>pulse.example.com</span><span class="dv-live"><span class="status-dot up"></span>Up</span></div>
            <div class="dv-rows">
              <div class="dv-row"><span class="status-dot up"></span><span class="dv-path">API</span><span class="dv-msg">99.99% · 42 ms</span></div>
              <div class="dv-row"><span class="status-dot up"></span><span class="dv-path">Web App</span><span class="dv-msg">100% · 36 ms</span></div>
              <div class="dv-row"><span class="status-dot up"></span><span class="dv-path">Docs</span><span class="dv-msg">99.98% · 58 ms</span></div>
            </div>
          </div>
          <div class="dv-frame dv-terminal">
            <div class="dv-head"><span class="terminal-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>pulsectl</span></div>
            <pre class="dv-code"><span class="dv-key">$</span> pulsectl monitor list
API      <span class="dv-num">UP</span>  42ms
Web App  <span class="dv-num">UP</span>  36ms
Docs     <span class="dv-num">UP</span>  58ms
<span class="dv-key">$</span> <span class="terminal-cursor" aria-hidden="true"></span></pre>
          </div>
        </div>`
    },
    neon: {
      kicker: "03 · Durable history",
      title: "Neon",
      copy: "Postgres that keeps the permanent record: incidents, exceptions, and compacted rollups. A storage governor enforces the budget, compacting routine checks so history never outgrows 500 MB.",
      stats: [["Writes", "State transitions"], ["Retention", "Budget-governed"], ["Typical size", "~120 MB"]],
      flow: "Pulse → Neon",
      visual: `
        <div class="dv-frame">
          <div class="dv-head"><span>psql · pulse</span><span>\\d</span></div>
          <pre class="dv-code"><span class="dv-tbl">incidents</span>
  id             <span class="dv-type">text · pk</span>
  monitor_id     <span class="dv-type">text · fk</span>
  opened_at      <span class="dv-type">timestamptz</span>
  resolved_at    <span class="dv-type">timestamptz</span>
  cause          <span class="dv-type">text</span>

<span class="dv-tbl">rollups_hourly</span>
  bucket         <span class="dv-type">timestamptz</span>
  monitor_id     <span class="dv-type">text · fk</span>
  checks         <span class="dv-type">integer</span>
  p50_ms         <span class="dv-type">integer</span></pre>
        </div>`
    },
    edge: {
      kicker: "04 · Zero-DB reads",
      title: "Edge Config",
      copy: "Holds the monitoring config and latest public state at the edge. The cron runner reads its config here every minute, and the status page reads current state the same way. Neither ever touches the database.",
      stats: [["Scheduler reads", "Every run"], ["Status reads", "Edge-cached"], ["Database hits", "None"]],
      flow: "Pulse → Edge Config → Scheduler · Status page",
      visual: `
        <div class="dv-frame">
          <div class="dv-head"><span>edge config · monitoring</span><span>read-only</span></div>
          <pre class="dv-code">{
  <span class="dv-key">"configVersion"</span>: <span class="dv-num">42</span>,
  <span class="dv-key">"monitors"</span>: [
    { <span class="dv-key">"id"</span>: <span class="dv-str">"api"</span>,  <span class="dv-key">"intervalSeconds"</span>: <span class="dv-num">60</span> },
    { <span class="dv-key">"id"</span>: <span class="dv-str">"web"</span>,  <span class="dv-key">"intervalSeconds"</span>: <span class="dv-num">300</span> },
    { <span class="dv-key">"id"</span>: <span class="dv-str">"docs"</span>, <span class="dv-key">"intervalSeconds"</span>: <span class="dv-num">900</span> }
  ],
  <span class="dv-key">"publicState"</span>: <span class="dv-str">"operational"</span>
}</pre>
        </div>`
    },
    resend: {
      kicker: "05 · Notifications",
      title: "Resend",
      copy: "Delivers one clear email when an outage is confirmed and one when recovery is confirmed. No flapping, no digest noise.",
      stats: [["On outage", "1 alert"], ["On recovery", "1 alert"], ["Flap noise", "None"]],
      flow: "Pulse → Resend",
      visual: `
        <div class="dv-frame">
          <div class="dv-head"><span>outbox</span><span>deduplicated</span></div>
          <div class="dv-rows">
            <div class="dv-row"><span class="status-dot up"></span><span class="dv-path">API is down</span><span class="dv-msg">team@example.com · 12:04:19 · sent</span></div>
            <div class="dv-row"><span class="status-dot up"></span><span class="dv-path">API recovered</span><span class="dv-msg">team@example.com · 12:06:20 · sent</span></div>
            <div class="dv-row"><span class="status-dot verifying"></span><span class="dv-path">Recovery confirmed</span><span class="dv-msg">team@example.com · queued</span></div>
            <div class="dv-row"><span class="status-dot"></span><span class="dv-path">Daily digest</span><span class="dv-msg">never · not a thing</span></div>
          </div>
        </div>`
    }
  };

  const archMap = $(".architecture-map");
  const systemDetail = $("#system-detail");
  let detailReturnFocus = null;

  function openSystemDetail(button) {
    const data = SYSTEM_DETAILS[button.dataset.node];
    if (!data || !systemDetail.hidden) return;
    $("#detail-kicker").textContent = data.kicker;
    $("#detail-title").textContent = data.title;
    $("#detail-copy").textContent = data.copy;
    $("#detail-stats").innerHTML = data.stats
      .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
      .join("");
    $("#detail-flow").textContent = data.flow;

    const inner = $(".detail-inner", systemDetail);
    const visual = $("#detail-visual");
    if (data.visual) {
      visual.innerHTML = data.visual;
      visual.hidden = false;
      inner.classList.add("has-visual");
    } else {
      visual.innerHTML = "";
      visual.hidden = true;
      inner.classList.remove("has-visual");
    }

    detailReturnFocus = button;
    systemDetail.hidden = false;
    archMap.classList.add("zoomed");

    if (!prefersReducedMotion()) {
      const from = button.getBoundingClientRect();
      const to = systemDetail.getBoundingClientRect();
      systemDetail.style.transition = "none";
      systemDetail.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
      systemDetail.style.opacity = "0.35";
      requestAnimationFrame(() => {
        systemDetail.style.transition = "transform 480ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity 320ms ease";
        systemDetail.style.transform = "none";
        systemDetail.style.opacity = "1";
      });
    }
    $(".detail-close", systemDetail).focus({ preventScroll: true });
  }

  function closeSystemDetail() {
    if (systemDetail.hidden) return;
    archMap.classList.remove("zoomed");
    const button = detailReturnFocus;
    const finish = () => {
      systemDetail.hidden = true;
      systemDetail.style.transition = "";
      systemDetail.style.transform = "";
      systemDetail.style.opacity = "";
      button?.focus({ preventScroll: true });
    };
    if (prefersReducedMotion() || !button) {
      finish();
      return;
    }
    const from = button.getBoundingClientRect();
    const to = systemDetail.getBoundingClientRect();
    systemDetail.style.transition = "transform 380ms cubic-bezier(0.4, 0, 0.2, 1), opacity 300ms ease";
    systemDetail.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
    systemDetail.style.opacity = "0";
    window.setTimeout(finish, 390);
  }

  $("[data-close-detail]").addEventListener("click", closeSystemDetail);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSystemDetail();
  });

  $$("[data-system]").forEach((button) => {
    const reveal = () => {
      $$(".system-node").forEach((node) => node.classList.toggle("active", node === button));
      const description = $("#system-description");
      if (description.textContent === button.dataset.system) return;
      description.classList.remove("fade-in");
      void description.offsetWidth;
      description.textContent = button.dataset.system;
      description.classList.add("fade-in");
    };
    button.addEventListener("mouseenter", reveal);
    button.addEventListener("focus", reveal);
    button.addEventListener("click", () => openSystemDetail(button));
  });

  elements.themeToggle.addEventListener("click", () => setTheme(demo.theme === "dark" ? "light" : "dark"));

  elements.menuToggle.addEventListener("click", () => {
    const open = elements.navLinks.classList.toggle("open");
    elements.menuToggle.setAttribute("aria-expanded", String(open));
    elements.menuToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  });

  $$("a", elements.navLinks).forEach((link) => link.addEventListener("click", () => {
    elements.navLinks.classList.remove("open");
    elements.menuToggle.setAttribute("aria-expanded", "false");
  }));

  const onScroll = () => elements.header.classList.toggle("scrolled", window.scrollY > 4);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  const revealTargets = $$("[data-reveal]");
  if ("IntersectionObserver" in window) {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    revealTargets.forEach((target) => revealObserver.observe(target));

    const sectionLinks = new Map();
    $$(".nav-links a[href^='#']").forEach((link) => sectionLinks.set(link.getAttribute("href").slice(1), link));
    const spyObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        sectionLinks.forEach((link) => link.classList.remove("active"));
        sectionLinks.get(entry.target.id)?.classList.add("active");
      });
    }, { rootMargin: "-30% 0px -60% 0px" });
    sectionLinks.forEach((link, id) => {
      const target = document.getElementById(id);
      if (target) spyObserver.observe(target);
    });
  } else {
    revealTargets.forEach((target) => target.classList.add("is-visible"));
  }

  const depSearch = $("#dep-search");
  if (depSearch) depSearch.addEventListener("input", () => renderDepCatalog(depSearch.value));
  const overlapIcon = $("#overlap-icon");
  if (overlapIcon) overlapIcon.innerHTML = depIcon("vercel");
  renderDepCatalog("");
  renderLogoStrip();

  setTheme(demo.theme);
  renderAll();
  renderDatabase($("#storage-range").value);
})();
