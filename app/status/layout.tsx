import type { ReactNode } from "react"

import styles from "@/components/status-page/status-page.module.css"
import { getStatusPageDisplayConfig } from "@/lib/reporting/queries/status"
import { cn } from "@/lib/utils"

/**
 * Public status shell. All personalization here is inert server-rendered
 * markup: the client bundle does not grow.
 *
 * customHead injection: a nested App Router segment cannot reach the real
 * <head> (only the root layout renders it), and React can only hoist parsed
 * elements, never a raw HTML string. So the accepted-self-XSS customHead
 * string is emitted as the first markup inside the page shell instead:
 * browsers execute <script>, apply <link rel=stylesheet>, and honor <style>
 * identically in body, which covers the analytics/fonts/styling this field
 * exists for. This is the documented tradeoff (strict head-only consumers,
 * e.g. some meta-tag verifiers, won't see it).
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
      {config.customHead ? (
        <div
          // biome-ignore lint/security/noDangerouslySetInnerHtml: custom head is the status page owner's own configured markup, an intentional customization
          dangerouslySetInnerHTML={{ __html: config.customHead }}
          data-status-custom-head
        />
      ) : null}
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
