import { Text } from "@react-email/components"
import { EmailLayout, emailMetaStyle, emailTextStyle } from "./layout"

export interface DependencyIncidentEmailProps {
  dependencyName: string
  provider: string
  incidentTitle: string
  state: string
  canonicalUrl: string | null
  providerTimestamp: string
}

export function DependencyIncidentEmail({
  dependencyName,
  provider,
  incidentTitle,
  state,
  canonicalUrl,
  providerTimestamp,
}: DependencyIncidentEmailProps) {
  return (
    <EmailLayout
      action={
        canonicalUrl
          ? { label: "View provider incident", url: canonicalUrl }
          : undefined
      }
      heading={`Provider reported: ${dependencyName}`}
      preview={`${provider} reported an incident affecting ${dependencyName}`}
    >
      <Text style={emailTextStyle}>
        {provider} reports {incidentTitle}
      </Text>
      <Text style={emailMetaStyle}>State {state}</Text>
      <Text style={emailMetaStyle}>Provider updated {providerTimestamp}</Text>
      <Text style={emailMetaStyle}>
        This reflects the provider&apos;s own status feed, not an independent
        Pulse check.
      </Text>
    </EmailLayout>
  )
}

// biome-ignore lint/complexity/noRedundantDefaultExport: react-email preview server discovers the default export, named export is used by the app
export default DependencyIncidentEmail
