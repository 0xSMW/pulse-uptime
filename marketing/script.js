(() => {
  "use strict";

  const stages = [
    {
      state: "UP",
      label: "Up",
      latency: 42,
      controlTitle: "Service is healthy",
      controlCopy: "Pulse is checking the endpoint every minute.",
      action: "Simulate Outage",
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
      controlTitle: "Failure detected",
      controlCopy: "One more failed check will confirm the outage.",
      action: "Advance Check",
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
      controlCopy: "The incident is open and the outage alert is sent.",
      action: "Outage Confirmed",
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
      controlCopy: "One more successful check will resolve the incident.",
      action: "Advance Check",
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
      controlTitle: "Service recovered",
      controlCopy: "The incident is resolved and recovery is confirmed.",
      action: "Restart Demo",
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
    theme: localStorage.getItem("pulse-marketing-theme") || "dark",
    monitors: [
      { id: "api", name: "API", url: "https://api.example.com/health", uptime: "99.99%", latency: 42, status: "UP", checked: "18s ago" },
      { id: "web", name: "Web App", url: "https://app.example.com", uptime: "100%", latency: 36, status: "UP", checked: "31s ago" },
      { id: "docs", name: "Docs", url: "https://docs.example.com", uptime: "99.98%", latency: 58, status: "UP", checked: "44s ago" }
    ]
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const elements = {
    monitorRows: $("#monitor-rows"),
    simBadge: $("#sim-status-badge"),
    simLatency: $("#sim-latency"),
    largeTimeline: $("#large-timeline"),
    controlHeading: $("#control-heading"),
    controlCopy: $("#control-copy"),
    advance: $("#advance-demo"),
    recover: $("#recover-demo"),
    reset: $("#reset-demo"),
    incidentBadge: $("#incident-badge"),
    incidentStarted: $("#incident-started"),
    incidentDuration: $("#incident-duration"),
    incidentCause: $("#incident-cause"),
    eventTrail: $("#event-trail"),
    publicState: $("#public-state"),
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

  function makeTimeline(state, count = 34) {
    const current = stateClass(state);
    return Array.from({ length: count }, (_, index) => {
      let segmentState = "up";
      if (index === count - 1) segmentState = current;
      if (demo.stage >= 2 && index >= count - 3) segmentState = "down";
      if (demo.stage === 3 && index === count - 1) segmentState = "verifying";
      if (demo.stage === 4 && index === count - 1) segmentState = "up";
      return `<span class="timeline-segment ${segmentState}" aria-hidden="true"></span>`;
    }).join("");
  }

  function renderMonitors() {
    elements.monitorRows.innerHTML = demo.monitors.map((monitor, index) => {
      const liveMonitor = index === 0;
      const stage = stages[demo.stage];
      const state = liveMonitor ? stage.state : monitor.status;
      const latency = liveMonitor ? stage.latency : monitor.latency;
      const status = stateClass(state);
      const pulse = status === "down" || status === "verifying" ? " pulse" : "";
      return `
        <tr tabindex="0" data-monitor-id="${escapeHtml(monitor.id)}" aria-label="View ${escapeHtml(monitor.name)} monitor">
          <td><span class="status-cell"><span class="status-dot ${status}${pulse}"></span>${statusLabel(state)}</span></td>
          <td><span class="monitor-name">${escapeHtml(monitor.name)}</span><span class="monitor-url">${escapeHtml(monitor.url)}</span></td>
          <td class="numeric mono">${liveMonitor && demo.stage >= 2 && demo.stage < 4 ? "99.86%" : monitor.uptime}</td>
          <td><div class="mini-timeline" aria-label="24 hour uptime timeline">${makeTimeline(state, 28)}</div></td>
          <td class="numeric mono">${latency === null ? "—" : `${latency} ms`}</td>
          <td class="numeric mono last-checked">${liveMonitor ? "Now" : monitor.checked}</td>
        </tr>`;
    }).join("");

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

  function renderLargeTimeline() {
    elements.largeTimeline.innerHTML = makeTimeline(stages[demo.stage].state, 48);
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
    elements.advance.textContent = stage.action;
    elements.advance.disabled = demo.stage === 2;
    elements.recover.disabled = demo.stage !== 2;

    $$(".state-step").forEach((step, index) => {
      step.classList.toggle("complete", index < demo.stage);
      step.classList.toggle("active", index === demo.stage);
    });

    renderLargeTimeline();
  }

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
      ? events.map(([eventClass, label, time]) => `<div class="event-item ${eventClass}"><span class="event-dot"></span><span>${label}</span><time>${time}</time></div>`).join("")
      : '<div class="empty-trail"><span class="status-dot up"></span><p>No incidents yet</p></div>';

    const publicKind = demo.stage === 2 || demo.stage === 3 ? (demo.stage === 2 ? "down" : "verifying") : "up";
    elements.publicState.className = `public-state ${publicKind}-state`;
    elements.publicState.innerHTML = `<span class="status-dot ${publicKind}${publicKind !== "up" ? " pulse" : ""}"></span><strong>${stage.publicTitle}</strong>`;
    elements.publicMonitorStatus.textContent = stage.publicStatus;

    const emailKind = stateClass(stage.state);
    elements.emailTitle.textContent = stage.emailTitle;
    elements.emailCopy.textContent = stage.emailCopy;
    elements.emailState.textContent = stage.emailState;
    const emailDot = $(".status-dot", elements.emailCard);
    emailDot.className = `status-dot ${emailKind}${emailKind !== "up" ? " pulse" : ""}`;
  }

  function cliData() {
    const stage = stages[demo.stage];
    const incidentStatus = demo.stage >= 2 && demo.stage < 4 ? "ONGOING" : demo.stage === 4 ? "RESOLVED" : "NONE";

    if (demo.command === "me") {
      if (demo.output === "json") {
        return JSON.stringify({ user: "hello@smw.ai", deployment: "pulse.example.com", authenticated: true }, null, 2);
      }
      return [
        "USER             DEPLOYMENT          AUTH",
        "hello@smw.ai     pulse.example.com   linked"
      ].join("\n");
    }

    if (demo.command === "monitors") {
      if (demo.output === "json") {
        return JSON.stringify(demo.monitors.map((monitor, index) => ({
          name: monitor.name,
          url: monitor.url,
          state: index === 0 ? stage.state : monitor.status,
          latency_ms: index === 0 ? stage.latency : monitor.latency
        })), null, 2);
      }
      const rows = demo.monitors.map((monitor, index) => {
        const state = index === 0 ? stage.state : monitor.status;
        const latency = index === 0 ? stage.latency : monitor.latency;
        return `${monitor.name.padEnd(14)} ${statusLabel(state).toUpperCase().padEnd(11)} ${latency === null ? "—" : `${latency}ms`}`;
      });
      return ["MONITOR        STATUS      LATENCY", ...rows].join("\n");
    }

    if (demo.output === "json") {
      return JSON.stringify({ monitor: "API", status: incidentStatus, cause: demo.stage >= 2 ? "TIMEOUT" : null }, null, 2);
    }
    return [
      "MONITOR        STATUS      CAUSE",
      `API            ${incidentStatus.padEnd(11)} ${demo.stage >= 2 ? "TIMEOUT" : "—"}`
    ].join("\n");
  }

  function renderCLI() {
    elements.terminalOutput.textContent = `$ ${commandValue()}\n\n${cliData()}`;
    elements.copyCommand.dataset.copyValue = commandValue();
    $$(".command").forEach((button) => button.classList.toggle("active", button.dataset.command === demo.command));
    $$("[data-output]").forEach((button) => button.classList.toggle("active", button.dataset.output === demo.output));
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
    renderCLI();
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

    demo.monitors.push({
      id: `monitor-${Date.now()}`,
      name,
      url,
      uptime: "—",
      latency: null,
      status: "PENDING",
      checked: "Pending"
    });
    renderMonitors();
    showToast("Monitor created");
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
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    window.clearTimeout(showToast.timeout);
    showToast.timeout = window.setTimeout(() => elements.toast.classList.remove("visible"), 1800);
  }

  function preferredScrollBehavior() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  }

  async function copyText(value, button) {
    try {
      await navigator.clipboard.writeText(value);
      const original = button.textContent;
      button.textContent = "Copied";
      showToast("Copied to clipboard");
      window.setTimeout(() => { button.textContent = original; }, 1400);
    } catch {
      showToast("Copy unavailable");
    }
  }

  function setTheme(theme) {
    demo.theme = theme;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pulse-marketing-theme", theme);
    const next = theme === "dark" ? "light" : "dark";
    elements.themeToggle.setAttribute("aria-label", `Use ${next} theme`);
    elements.themeToggle.dataset.tooltip = `${next[0].toUpperCase()}${next.slice(1)} theme`;
    elements.themeToggle.firstElementChild.textContent = theme === "dark" ? "☼" : "☾";
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
  }

  elements.advance.addEventListener("click", () => {
    if (demo.stage === 4) setStage(0);
    else if (demo.stage !== 2) setStage(demo.stage + 1);
  });
  elements.recover.addEventListener("click", () => setStage(3));
  elements.reset.addEventListener("click", () => setStage(0));

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

  $("#inline-monitor-form").addEventListener("submit", (event) => {
    event.preventDefault();
    addMonitor(event.currentTarget);
    $("#monitor-form-note").textContent = "Monitor added to the live dashboard";
    $("#product").scrollIntoView({ behavior: preferredScrollBehavior(), block: "center" });
  });

  $("#dialog-monitor-form").addEventListener("submit", (event) => {
    event.preventDefault();
    addMonitor(event.currentTarget);
    elements.dialog.close();
  });

  $$(".command").forEach((button) => button.addEventListener("click", () => {
    demo.command = button.dataset.command;
    renderCLI();
  }));

  $$("[data-output]").forEach((button) => button.addEventListener("click", () => {
    demo.output = button.dataset.output;
    renderCLI();
  }));

  elements.copyCommand.addEventListener("click", () => copyText(elements.copyCommand.dataset.copyValue, elements.copyCommand));

  $("#reveal-agent-prompt").addEventListener("click", (event) => {
    const prompt = $("#agent-prompt");
    const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
    event.currentTarget.setAttribute("aria-expanded", String(!expanded));
    event.currentTarget.textContent = expanded ? "Show Agent Prompt" : "Hide Agent Prompt";
    prompt.hidden = expanded;
  });

  $$("[data-copy-target]").forEach((button) => button.addEventListener("click", () => {
    const target = $(`#${button.dataset.copyTarget} code`);
    copyText(target.textContent.trim(), button);
  }));

  $("#storage-range").addEventListener("input", (event) => renderDatabase(event.currentTarget.value));

  $$("[data-system]").forEach((button) => {
    const reveal = () => { $("#system-description").textContent = button.dataset.system; };
    button.addEventListener("mouseenter", reveal);
    button.addEventListener("focus", reveal);
    button.addEventListener("click", reveal);
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

  setTheme(demo.theme);
  renderAll();
  renderDatabase($("#storage-range").value);
})();
