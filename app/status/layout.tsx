import { headers } from "next/headers"
import type { ReactNode } from "react"

import styles from "@/components/status-page/status-page.module.css"
import { getStatusPageDisplayConfig } from "@/lib/reporting/queries/status"
import { renderSafeCustomHead } from "@/lib/status-page/custom-head"
import { cn } from "@/lib/utils"

/**
 * Public status shell. All personalization here is inert server-rendered
 * markup: the client bundle does not grow.
 *
 * customHead: restricted meta and icon link elements only. React hoists
 * validated elements into the document head even when this nested layout
 * emits them from the page shell. They remain React nodes, not raw HTML.
 * customCss is loaded from a text/css resource so it never enters an HTML raw
 * text context. The Google tag uses the request nonce from the status CSP.
 */
export default async function PublicStatusLayout({
  children,
}: {
  children: ReactNode
}) {
  const config = await getStatusPageDisplayConfig()
  const nonce = (await headers()).get("x-nonce") ?? undefined
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
        <link href="/status/custom.css" rel="stylesheet" />
      ) : null}
      {children}
      {config.googleTagId ? (
        <>
          <script
            async
            nonce={nonce}
            src={`https://www.googletagmanager.com/gtag/js?id=${config.googleTagId}`}
          />
          <script
            // The tag id is schema-validated (^G(T)?-[A-Z0-9]+$), so it cannot
            // break out of this inline snippet.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: static gtag bootstrap with a schema-validated tag id, no untrusted data
            dangerouslySetInnerHTML={{
              __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${config.googleTagId}');`,
            }}
            nonce={nonce}
          />
        </>
      ) : null}
    </div>
  )
}
