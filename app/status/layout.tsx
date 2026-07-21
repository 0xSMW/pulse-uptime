import type { ReactNode } from "react"

import styles from "@/components/status-page/status-page.module.css"
import { getStatusPageDisplayConfig } from "@/lib/reporting/queries/status"
import { renderSafeCustomHead } from "@/lib/status-page/custom-head"
import { cn } from "@/lib/utils"

/**
 * Public status shell. All personalization here is inert server-rendered
 * markup: the client bundle does not grow.
 *
 * customHead: restricted meta and icon link elements only. A nested App
 * Router segment cannot reach the real <head>, so validated elements are
 * emitted as React nodes inside the page shell (not raw HTML). customCss
 * and the Google tag stay on their existing paths.
 */
export default async function PublicStatusLayout({
  children,
}: {
  children: ReactNode
}) {
  const config = await getStatusPageDisplayConfig()
  const forcedTheme = config.theme === "system" ? null : config.theme

  return (
    <div
      className={cn(
        styles.shell,
        forcedTheme === "light" && styles.light,
        forcedTheme === "dark" && styles.dark
      )}
      data-theme={forcedTheme ?? undefined}
    >
      {renderSafeCustomHead(config.customHead)}
      {config.customCss ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: custom css is the status page owner's own configured stylesheet, an intentional customization
        <style dangerouslySetInnerHTML={{ __html: config.customCss }} />
      ) : null}
      {children}
      {config.googleTagId ? (
        <>
          <script
            async
            src={`https://www.googletagmanager.com/gtag/js?id=${config.googleTagId}`}
          />
          <script
            // The tag id is schema-validated (^G(T)?-[A-Z0-9]+$), so it cannot
            // break out of this inline snippet.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: static gtag bootstrap with a schema-validated tag id, no untrusted data
            dangerouslySetInnerHTML={{
              __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${config.googleTagId}');`,
            }}
          />
        </>
      ) : null}
    </div>
  )
}
