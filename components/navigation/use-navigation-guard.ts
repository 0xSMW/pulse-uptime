"use client"

import { useRouter } from "next/navigation"
import * as React from "react"

import { ConfirmDialog } from "@/components/ui/confirm-dialog"

export interface NavigationGuardOptions {
  title: React.ReactNode
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
}

type Pending = { kind: "click"; href: string } | { kind: "popstate" } | null

/**
 * Confirms with the user, via an in-app modal, before any client-visible way
 * of leaving the current page while `dirty` is true. Mount once per "dirty
 * scope" (e.g. a context provider or the component that owns the dirty
 * boolean) and render the returned node. The guards it installs are global
 * (`window`/`document` listeners), so it does not matter where in the tree
 * the caller lives relative to the links it ends up protecting, but the
 * returned dialog must be rendered somewhere for the modal to appear.
 *
 * Covers three distinct ways a user can leave:
 *
 * 1. Hard navigations (reload, close tab, typed URL, external links) bypass
 *    client-side routing entirely. The native `beforeunload` prompt is the
 *    only guard available here, and browsers do not allow custom UI on it
 *    (the dialog text is browser-controlled or absent). This is the one
 *    exception to "in-app modal" in this hook, imposed by the platform.
 *
 * 2. Same-document history navigation (browser Back/Forward). The History
 *    API cannot cancel a `popstate`: by the time the event fires, the URL
 *    (and, in Next's App Router, the rendered route) has already changed.
 *    The standard workaround, used here, is to push a sentinel history entry
 *    on top of the current one while dirty. A Back press pops the sentinel
 *    and fires `popstate`. Because the confirmation dialog is asynchronous,
 *    the handler re-pushes the sentinel immediately and synchronously,
 *    before opening the dialog, so the address bar never shows the wrong
 *    page while the user is deciding. Declining leaves that restored state
 *    alone. Confirming sets a `leaving` flag and calls
 *    `history.go(-2)`: one step past the re-pushed sentinel, one more past
 *    the entry the original pop landed on, to reach the entry the user was
 *    actually headed for, and ignores the popstate that traversal fires.
 *
 *    Limits: this can only guard the entry immediately behind the current
 *    one. A user who presses Back twice in quick succession (before this
 *    effect's `popstate` handler has re-armed) or a Forward that lands more
 *    than one entry away can outrun it. It cannot tell Back from Forward, so
 *    a confirmed Forward still exits backward. And because a pushed entry
 *    cannot be programmatically removed, the sentinel outlives a
 *    dirty-to-clean transition (e.g. a save): the next Back after saving
 *    needs one extra press.
 *
 * 3. Same-document link clicks anywhere in the document (nav bars, logos,
 *    sidebars: anything rendered as `<a href>`, including ones added after
 *    this hook mounts). A capture-phase `click` listener on `document` finds
 *    the nearest `a[href]` ancestor of the click target. Because the
 *    confirmation dialog is asynchronous, the click cannot be decided inside
 *    the handler, so it is intercepted unconditionally while dirty:
 *    `preventDefault()` stops Next's `<Link>` from starting its transition
 *    (Link checks `defaultPrevented` before navigating), the target href is
 *    stashed, and the dialog opens. Confirming navigates to the stashed href
 *    afterward, through the router for a same-origin href, or
 *    `window.location.assign` for a cross-origin one, since the router
 *    cannot navigate off-origin. Declining just closes the dialog. The click
 *    is already cancelled, so there is nothing else to undo.
 *
 *    Ignored on purpose (checked before the unconditional intercept above):
 *    modified clicks (ctrl/cmd/shift/alt, i.e. "open in new tab"), non-
 *    primary-button clicks, `target="_blank"`, `download` links, and
 *    same-page hash-only links (`href="#..."`). Everything else, including
 *    links to external hosts, gets the same dialog. That's intentionally
 *    conservative rather than trying to detect in-app vs. external targets.
 *
 *    This does not cover programmatic navigation (`router.push(...)` called
 *    from code, with no DOM click to intercept). Callers that navigate
 *    imperatively after a user action must guard that themselves.
 */
export function useNavigationGuard(
  dirty: boolean,
  options: NavigationGuardOptions
): React.ReactNode {
  const router = useRouter()
  const [pending, setPending] = React.useState<Pending>(null)
  // Shared between the popstate listener and confirm(): the traversal that
  // confirm() kicks off (history.go(-2)) fires its own popstate later, from
  // a separate call, so a ref is needed to signal across that gap instead of
  // a plain closure variable. Reset to false each time the effect below
  // (re)installs its listener.
  const leavingRef = React.useRef(false)

  React.useEffect(() => {
    if (!dirty) {
      return
    }
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [dirty])

  React.useEffect(() => {
    if (!dirty) {
      return
    }
    leavingRef.current = false
    function onPopState() {
      if (leavingRef.current) {
        return
      }
      // Restore the address bar first, synchronously, so it never shows the
      // entry the pop landed on while the (asynchronous) dialog is open.
      window.history.pushState(null, "", window.location.href)
      setPending({ kind: "popstate" })
    }
    // Sentinel entry: see the "Limits" note above.
    window.history.pushState(null, "", window.location.href)
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [dirty])

  React.useEffect(() => {
    if (!dirty) {
      return
    }
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) {
        return
      }
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return
      }
      const target = event.target as HTMLElement | null
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null
      if (!anchor) {
        return
      }
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) {
        return
      }
      const href = anchor.getAttribute("href") ?? ""
      if (href.startsWith("#")) {
        return
      }
      // Unconditional: a modal cannot be awaited synchronously inside a
      // click handler the way window.confirm could, so every qualifying
      // click is stopped and re-issued as a navigation after the user
      // decides (see confirm() below).
      event.preventDefault()
      setPending({ kind: "click", href })
    }
    document.addEventListener("click", onClick, true)
    return () => document.removeEventListener("click", onClick, true)
  }, [dirty])

  const confirm = React.useCallback(() => {
    if (!pending) {
      return
    }
    if (pending.kind === "popstate") {
      leavingRef.current = true
      setPending(null)
      // history.go(-2): one entry past the sentinel the popstate handler
      // re-pushed, one more past the entry the original Back/Forward landed
      // on, to reach the entry the user actually meant to go to.
      // leavingRef suppresses the popstate this traversal fires.
      window.history.go(-2)
      return
    }
    const href = pending.href
    setPending(null)
    let url: URL
    try {
      url = new URL(href, window.location.href)
    } catch {
      window.location.assign(href)
      return
    }
    if (url.origin === window.location.origin) {
      router.push(href)
    } else {
      window.location.assign(href)
    }
  }, [pending, router])

  const cancel = React.useCallback(() => {
    setPending(null)
  }, [])

  return React.createElement(ConfirmDialog, {
    open: pending !== null,
    title: options.title,
    description: options.description,
    confirmLabel: options.confirmLabel ?? "Discard",
    cancelLabel: options.cancelLabel ?? "Cancel",
    destructive: true,
    onConfirm: confirm,
    onCancel: cancel,
  })
}
