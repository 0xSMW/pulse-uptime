import { Text } from "@react-email/components"
import { EmailLayout, emailMetaStyle, emailTextStyle } from "./layout"

export interface OutageEmailProps {
  monitorName: string
  incidentUrl: string
  startedAt: string
  cause: string
}

export function OutageEmail({
  monitorName,
  incidentUrl,
  startedAt,
  cause,
}: OutageEmailProps) {
  return (
    <EmailLayout
      action={{ label: "View incident", url: incidentUrl }}
      heading={`${monitorName} is down`}
      preview={`${monitorName} is down`}
    >
      <Text style={emailTextStyle}>
        Pulse confirmed an outage after repeated failed checks
      </Text>
      <Text style={emailMetaStyle}>Started {startedAt}</Text>
      <Text style={emailMetaStyle}>Cause {cause}</Text>
    </EmailLayout>
  )
}

// biome-ignore lint/complexity/noRedundantDefaultExport: react-email preview server discovers the default export, named export is used by the app
export default OutageEmail
