import { Text } from "@react-email/components"
import { EmailLayout, emailMetaStyle, emailTextStyle } from "./layout"

const PORKBUN_DOMAIN_MANAGER_URL = "https://porkbun.com/account/domainsSpeedy"

export interface DomainExpiryEmailProps {
  apexDomain: string
  expiresAt: string
  thresholdDays: 30 | 14
  autoRenew: boolean | null
}

function autoRenewLabel(autoRenew: boolean | null): string {
  if (autoRenew === true) {
    return "Auto-renew enabled"
  }
  if (autoRenew === false) {
    return "Auto-renew disabled"
  }
  return "Auto-renew status unavailable"
}

export function DomainExpiryEmail({
  apexDomain,
  expiresAt,
  thresholdDays,
  autoRenew,
}: DomainExpiryEmailProps) {
  const heading = `${apexDomain} expires in ${thresholdDays} days`
  return (
    <EmailLayout
      action={{
        label: "Manage domain at Porkbun",
        url: PORKBUN_DOMAIN_MANAGER_URL,
      }}
      heading={heading}
      preview={heading}
    >
      <Text style={emailTextStyle}>
        Review this domain registration before it expires
      </Text>
      <Text style={emailMetaStyle}>Domain {apexDomain}</Text>
      <Text style={emailMetaStyle}>Expires {expiresAt}</Text>
      <Text style={emailMetaStyle}>Alert threshold {thresholdDays} days</Text>
      <Text style={emailMetaStyle}>{autoRenewLabel(autoRenew)}</Text>
    </EmailLayout>
  )
}

// biome-ignore lint/complexity/noRedundantDefaultExport: react-email preview server discovers the default export, named export is used by the app
export default DomainExpiryEmail
