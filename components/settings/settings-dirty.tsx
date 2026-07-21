"use client"

import Link from "next/link"
import * as React from "react"

import { useNavigationGuard } from "@/components/navigation/use-navigation-guard"

export const DISCARD_PROMPT = "Discard unsaved changes?"

type SettingsDirtyContextValue = {
  dirty: boolean
  markDirty: (key: string, dirty: boolean) => void
}

const SettingsDirtyContext =
  React.createContext<SettingsDirtyContextValue | null>(null)

/**
 * Settings-shell dirty state. Any dirty form suppresses the Esc exit and makes
 * "Back to app" and sidebar navigation confirm before discarding.
 */
export function SettingsDirtyProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [dirtyKeys, setDirtyKeys] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )

  const markDirty = React.useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((current) => {
      if (current.has(key) === dirty) {
        return current
      }
      const next = new Set(current)
      if (dirty) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })
  }, [])

  const dirty = dirtyKeys.size > 0

  // Guards every way a user can leave while dirty: hard navigations
  // (beforeunload), browser Back/Forward (same-document history
  // navigation), and any link click in the document, including sidebar
  // items, "Back to app", and TopNav/logo alike. See useNavigationGuard for
  // the techniques and their limits. The dialog it returns must be rendered
  // for the modal to appear.
  const guardDialog = useNavigationGuard(dirty, {
    title: "Discard unsaved changes?",
    description: DISCARD_PROMPT,
    confirmLabel: "Discard",
    cancelLabel: "Keep Editing",
  })

  const value = React.useMemo(() => ({ dirty, markDirty }), [dirty, markDirty])

  return (
    <SettingsDirtyContext.Provider value={value}>
      {children}
      {guardDialog}
    </SettingsDirtyContext.Provider>
  )
}

/** Null outside the settings shell so shared components stay reusable. */
export function useSettingsDirty(): SettingsDirtyContextValue | null {
  return React.useContext(SettingsDirtyContext)
}

/**
 * A next/link. The unsaved-changes confirm is provided globally by
 * SettingsDirtyProvider's useNavigationGuard (a document-wide click
 * listener), so this component must not add its own confirm here, since
 * that would double-confirm alongside the global one. Kept as a named
 * export, rather than inlining next/link at call sites, so existing usages
 * don't need to change if a link-specific behavior is needed here again
 * later.
 */
export function GuardedLink(props: React.ComponentProps<typeof Link>) {
  return <Link {...props} />
}

/** Registers a form's dirty state with the settings shell while mounted. */
export function useDirtyGuard(key: string, isDirty: boolean) {
  const context = useSettingsDirty()
  const markDirty = context?.markDirty
  React.useEffect(() => {
    if (!markDirty) {
      return
    }
    markDirty(key, isDirty)
    return () => markDirty(key, false)
  }, [markDirty, key, isDirty])
}
