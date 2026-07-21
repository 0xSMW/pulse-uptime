import { Text } from "@react-email/components"
import { EmailLayout, emailMetaStyle, emailTextStyle } from "./layout"

export interface RecoveryEmailProps {
  monitorName: string
  incidentUrl: string
  recoveredAt: string
  duration: string
}

export function RecoveryEmail({
  monitorName,
  incidentUrl,
  recoveredAt,
  duration,
}: RecoveryEmailProps) {
  return (
    <EmailLayout
      action={{ label: "View incident", url: incidentUrl }}
      heading={`${monitorName} recovered`}
      preview={`${monitorName} recovered`}
    >
      <Text style={emailTextStyle}>
        Pulse confirmed the endpoint is responding again
      </Text>
      <Text style={emailMetaStyle}>Recovered {recoveredAt}</Text>
      <Text style={emailMetaStyle}>Duration {duration}</Text>
    </EmailLayout>
  )
}

// biome-ignore lint/complexity/noRedundantDefaultExport: react-email preview server discovers the default export, named export is used by the app
export default RecoveryEmail
