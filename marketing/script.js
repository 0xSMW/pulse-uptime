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

  function cliData() {
    const stage = stages[demo.stage];
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
      .replace(/\bNONE\b/g, '<span class="t-muted">NONE</span>');
  }

  function printCLI(command) {
    elements.terminalOutput.innerHTML = `<span class="t-prompt">$</span> ${escapeHtml(command)}\n\n${decorateOutput(cliData())}\n\n<span class="t-prompt">$</span> <span class="terminal-cursor" aria-hidden="true"></span>`;
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
    return demo.output === "json" ? "pulsectl incident list --output json" : "pulsectl incident list";
  }

  function renderAll() {
    renderMonitors();
    renderSimulation();
    renderIncident();
    renderStatusPage();
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
      $(".mono", row).textContent = `${mb} MB`;
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

  $$("[data-copy-target]").forEach((button) => button.addEventListener("click", () => {
    const target = $(`#${button.dataset.copyTarget} code`);
    copyText(target.textContent.trim(), button);
  }));

  $("#storage-range").addEventListener("input", (event) => renderDatabase(event.currentTarget.value));

  const SYSTEM_DETAILS = {
    cron: {
      kicker: "01 · Scheduler",
      title: "Vercel Cron",
      copy: "Fires once per minute and hands Pulse a single packed batch of due checks. No worker fleet, no queue to babysit. Every monitor keeps its own configurable interval, from one minute up.",
      stats: [["Cadence", "1 run / min"], ["Intervals", "1 · 5 · 15 min"], ["Idle compute", "None"]],
      flow: "Vercel Cron → Pulse"
    },
    pulse: {
      kicker: "02 · Control plane",
      title: "Pulse",
      copy: "Runs every check, resolves state transitions, opens and closes incidents, and serves the dashboard, API, and CLI from one deployment.",
      stats: [["Checks", "HTTP + latency"], ["States", "Up · Verifying · Down"], ["Interfaces", "UI · API · CLI"]],
      flow: "Vercel Cron → Pulse → Neon · Edge Config · Resend"
    },
    neon: {
      kicker: "03 · Durable history",
      title: "Neon",
      copy: "Postgres that keeps the permanent record: incidents, exceptions, and compacted rollups. A storage governor enforces the budget, compacting routine checks so history never outgrows 500 MB.",
      stats: [["Writes", "State transitions"], ["Retention", "Budget-governed"], ["Typical size", "~120 MB"]],
      flow: "Pulse → Neon"
    },
    edge: {
      kicker: "04 · Zero-DB reads",
      title: "Edge Config",
      copy: "Holds the monitoring config and latest public state at the edge. The cron runner reads its config here every minute, and the status page reads current state the same way. Neither ever touches the database.",
      stats: [["Scheduler reads", "Every run"], ["Status reads", "Edge-cached"], ["Database hits", "None"]],
      flow: "Pulse → Edge Config → Scheduler · Status page"
    },
    resend: {
      kicker: "05 · Notifications",
      title: "Resend",
      copy: "Delivers one clear email when an outage is confirmed and one when recovery is confirmed. No flapping, no digest noise.",
      stats: [["On outage", "1 alert"], ["On recovery", "1 alert"], ["Flap noise", "None"]],
      flow: "Pulse → Resend"
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

  setTheme(demo.theme);
  renderAll();
  renderDatabase($("#storage-range").value);
})();
