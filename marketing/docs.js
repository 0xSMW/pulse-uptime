;(() => {
  const $ = (selector, scope = document) => scope.querySelector(selector)
  const $$ = (selector, scope = document) => [
    ...scope.querySelectorAll(selector),
  ]

  const escapeHtml = (value) =>
    value.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]
    )

  document.documentElement.classList.add("js")

  /* ---- Theme ---- */

  const themeToggle = $("#theme-toggle")

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem("pulse-marketing-theme", theme)
    } catch {
      /* private mode */
    }
    const next = theme === "dark" ? "light" : "dark"
    themeToggle.setAttribute("aria-label", `Use ${next} theme`)
    themeToggle.dataset.tooltip = `${next[0].toUpperCase()}${next.slice(1)} theme`
  }

  themeToggle.addEventListener("click", () =>
    setTheme(
      document.documentElement.dataset.theme === "dark" ? "light" : "dark"
    )
  )
  setTheme(document.documentElement.dataset.theme || "dark")

  /* ---- Header ---- */

  const header = $(".site-header")
  const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 4)
  window.addEventListener("scroll", onScroll, { passive: true })
  onScroll()

  const menuToggle = $("#menu-toggle")
  const navLinks = $("#nav-links")

  menuToggle.addEventListener("click", () => {
    const open = navLinks.classList.toggle("open")
    menuToggle.setAttribute("aria-expanded", String(open))
    menuToggle.setAttribute(
      "aria-label",
      open ? "Close navigation" : "Open navigation"
    )
  })

  document.addEventListener("click", (event) => {
    if (
      navLinks.classList.contains("open") &&
      !navLinks.contains(event.target) &&
      !menuToggle.contains(event.target)
    ) {
      navLinks.classList.remove("open")
      menuToggle.setAttribute("aria-expanded", "false")
    }
  })

  /* ---- Mobile contents ---- */

  const contentsToggle = $("#contents-toggle")
  const sidebar = $("#docs-sidebar")

  contentsToggle.addEventListener("click", () => {
    const open = sidebar.classList.toggle("open")
    contentsToggle.setAttribute("aria-expanded", String(open))
  })

  sidebar.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      sidebar.classList.remove("open")
      contentsToggle.setAttribute("aria-expanded", "false")
    }
  })

  /* ---- Toast + copy ---- */

  const toast = $("#toast")

  function showToast(message) {
    toast.innerHTML = `<span class="status-dot up" aria-hidden="true"></span>${escapeHtml(message)}`
    toast.classList.add("visible")
    window.clearTimeout(showToast.timeout)
    showToast.timeout = window.setTimeout(
      () => toast.classList.remove("visible"),
      1800
    )
  }

  async function copyText(value, button) {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      const helper = document.createElement("textarea")
      helper.value = value
      document.body.append(helper)
      helper.select()
      document.execCommand("copy")
      helper.remove()
    }
    showToast("Copied to clipboard")
    if (button) {
      button.classList.add("success")
      const label = button.textContent
      button.textContent = "Copied"
      window.setTimeout(() => {
        button.classList.remove("success")
        button.textContent = label
      }, 1400)
    }
  }

  /* ---- Syntax highlighting ----
     Minimal ordered-rule tokenizer. Each rule is [class, sticky regex,
     wordStart?]; the first rule matching at the cursor wins, otherwise the
     character passes through escaped. */

  const BASH_COMMANDS =
    /(?:pulsectl|curl|brew|vercel|neonctl|pnpm|npm|jq|openssl|git|export|source|set|cd|ssh)/

  const GRAMMARS = {
    bash: [
      ["comment", /#[^\n]*/y],
      ["string", /"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/y],
      ["var", /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/y],
      ["flag", /--?[A-Za-z][\w-]*/y, true],
      ["cmd", new RegExp(`${BASH_COMMANDS.source}(?=\\s|$)`, "y"), true],
      ["keyword", /\b(?:GET|POST|PATCH|DELETE|HEAD|PUT)(?=\s|$)/y, true],
      ["number", /\d+(?:\.\d+)?/y, true],
      ["punct", /[|&;<>(){}[\]=\\]/y],
    ],
    json: [
      ["key", /"(?:[^"\\]|\\.)*"(?=\s*:)/y],
      ["string", /"(?:[^"\\]|\\.)*"/y],
      ["keyword", /(?:true|false|null)/y, true],
      ["number", /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, true],
      ["punct", /[{}[\],:]/y],
    ],
    yaml: [
      ["comment", /#[^\n]*/y],
      ["key", /[A-Za-z_][\w.-]*(?=:(?:\s|$))/y, true],
      ["string", /"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/y],
      ["keyword", /(?:true|false|null)(?=\s|$)/y, true],
      ["number", /-?\d+(?:\.\d+)?(?=\s|$)/y, true],
      ["punct", /[:{}[\],]|-(?=\s)/y],
    ],
    http: [
      ["keyword", /(?:GET|POST|PATCH|DELETE|HEAD|PUT|HTTP\/[\d.]+)/y, true],
      ["key", /[A-Za-z][A-Za-z-]*(?=: )/y, true],
      ["string", /"(?:[^"\\]|\\.)*"/y],
      ["number", /\b\d{3}\b/y, true],
      ["punct", /[:,]/y],
    ],
  }

  const isWordChar = (char) => /[\w-]/.test(char || "")

  function highlight(source, rules) {
    let html = ""
    let index = 0
    while (index < source.length) {
      let matched = null
      for (const [cls, regex, wordStart] of rules) {
        if (wordStart && index > 0 && isWordChar(source[index - 1])) {
          continue
        }
        regex.lastIndex = index
        const match = regex.exec(source)
        if (match?.[0]) {
          matched = [cls, match[0]]
          break
        }
      }
      if (matched) {
        html += `<span class="tok-${matched[0]}">${escapeHtml(matched[1])}</span>`
        index += matched[1].length
      } else {
        html += escapeHtml(source[index])
        index += 1
      }
    }
    return html
  }

  for (const block of $$("pre code[class*='language-']")) {
    const lang = (block.className.match(/language-(\w+)/) || [])[1]
    const rules = GRAMMARS[lang === "sh" || lang === "shell" ? "bash" : lang]
    if (rules) {
      block.innerHTML = highlight(block.textContent, rules)
    }
  }

  /* ---- Code tabs ---- */

  for (const tabs of $$(".code-tabs")) {
    const figure = tabs.closest(".code-block, .dv-frame")
    for (const tab of $$(".code-tab", tabs)) {
      tab.addEventListener("click", () => {
        for (const other of $$(".code-tab", tabs)) {
          const active = other === tab
          other.classList.toggle("active", active)
          other.setAttribute("aria-selected", String(active))
        }
        for (const panel of $$(".code-tab-panel", figure)) {
          panel.hidden = panel.dataset.tabPanel !== tab.dataset.tab
        }
      })
    }
  }

  /* ---- Code copy buttons ---- */

  for (const figure of $$(".code-block")) {
    const button = $(".code-copy", figure)
    if (!button) {
      continue
    }
    button.addEventListener("click", () => {
      const code =
        $(".code-tab-panel:not([hidden]) code", figure) || $("pre code", figure)
      if (!code) {
        return
      }
      const text = code.textContent
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n")
        .trim()
      copyText(text || code.textContent.trim(), button)
    })
  }

  /* ---- Heading anchors ---- */

  for (const heading of $$(
    ".docs-main h2[id], .docs-main h3[id], .docs-main h4[id]"
  )) {
    heading.classList.add("anchor-heading")
    const anchor = document.createElement("a")
    anchor.className = "anchor-link"
    anchor.href = `#${heading.id}`
    anchor.setAttribute("aria-label", `Link to ${heading.textContent.trim()}`)
    anchor.textContent = "#"
    heading.append(anchor)
  }

  /* ---- Scrollspy ---- */

  const sidebarLinks = $$(".sidebar-group a")
  const spyTargets = [
    ...new Set(sidebarLinks.map((link) => link.hash.slice(1))),
  ]
    .map((id) => document.getElementById(id))
    .filter(Boolean)
    .sort((a, b) => a.offsetTop - b.offsetTop)

  let spyFrame = 0

  function updateSpy() {
    spyFrame = 0
    const cursor = window.scrollY + 120
    let current = spyTargets[0]
    for (const target of spyTargets) {
      if (target.offsetTop <= cursor) {
        current = target
      } else {
        break
      }
    }
    const atBottom =
      window.innerHeight + window.scrollY >= document.body.offsetHeight - 4
    if (atBottom) {
      current = spyTargets.at(-1)
    }
    const id = current ? current.id : ""
    for (const link of sidebarLinks) {
      link.classList.toggle("active", link.hash === `#${id}`)
    }
    for (const group of $$(".sidebar-group")) {
      const owns = $$("a", group).some((link) => link.hash === `#${id}`)
      group.classList.toggle("expanded", owns)
    }
  }

  window.addEventListener(
    "scroll",
    () => {
      if (!spyFrame) {
        spyFrame = requestAnimationFrame(updateSpy)
      }
    },
    { passive: true }
  )
  window.addEventListener("resize", updateSpy)
  updateSpy()

  /* ---- Command palette ---- */

  const palette = $("#command-palette")
  const paletteInput = $("#palette-input")
  const paletteList = $("#palette-list")
  let paletteMatches = []
  let paletteIndex = 0

  const PALETTE_COMMANDS = sidebarLinks.map((link) => ({
    label: link.textContent.trim(),
    hint: link
      .closest(".sidebar-group")
      .querySelector("p")
      .textContent.trim()
      .toLowerCase(),
    run: () => {
      window.location.hash = link.hash
    },
  }))

  PALETTE_COMMANDS.push(
    {
      label: "Toggle theme",
      hint: "appearance",
      run: () =>
        setTheme(
          document.documentElement.dataset.theme === "dark" ? "light" : "dark"
        ),
    },
    {
      label: "Copy install command",
      hint: "cli",
      run: () =>
        copyText(
          "go install github.com/0xSMW/pulse-uptime/cli/cmd/pulsectl@latest"
        ),
    },
    {
      label: "Open marketing page",
      hint: "navigate",
      run: () => {
        window.location.href = "./index.html"
      },
    }
  )

  function renderPalette(query = "") {
    const value = query.trim().toLowerCase()
    paletteMatches = PALETTE_COMMANDS.filter((command) =>
      command.label.toLowerCase().includes(value)
    )
    paletteIndex = Math.min(
      paletteIndex,
      Math.max(0, paletteMatches.length - 1)
    )
    paletteList.innerHTML = paletteMatches.length
      ? paletteMatches
          .map(
            (command, index) =>
              `<li class="palette-item${index === paletteIndex ? " selected" : ""}" data-index="${index}" role="option"><span>${escapeHtml(command.label)}</span><span class="hint">${escapeHtml(command.hint)}</span></li>`
          )
          .join("")
      : '<li class="palette-empty">No matching entry</li>'
    for (const item of $$(".palette-item", paletteList)) {
      item.addEventListener("click", runSelected)
      item.addEventListener("mousemove", () => {
        const index = Number(item.dataset.index)
        if (index === paletteIndex) {
          return
        }
        paletteIndex = index
        for (const other of $$(".palette-item", paletteList)) {
          other.classList.toggle(
            "selected",
            Number(other.dataset.index) === paletteIndex
          )
        }
      })
    }
  }

  function runSelected() {
    const command = paletteMatches[paletteIndex]
    if (!command) {
      return
    }
    palette.close()
    command.run()
  }

  function openPalette() {
    if (palette.open) {
      palette.close()
      return
    }
    paletteIndex = 0
    paletteInput.value = ""
    renderPalette()
    palette.showModal()
    paletteInput.focus()
  }

  paletteInput.addEventListener("input", () => {
    paletteIndex = 0
    renderPalette(paletteInput.value)
  })

  paletteInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      paletteIndex = Math.min(
        paletteIndex + 1,
        Math.max(0, paletteMatches.length - 1)
      )
      renderPalette(paletteInput.value)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      paletteIndex = Math.max(paletteIndex - 1, 0)
      renderPalette(paletteInput.value)
    } else if (event.key === "Enter") {
      event.preventDefault()
      runSelected()
    }
  })

  palette.addEventListener("click", (event) => {
    if (event.target === palette) {
      palette.close()
    }
  })

  for (const button of $$("[data-open-palette]")) {
    button.addEventListener("click", openPalette)
  }

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault()
      openPalette()
    }
  })
})()
