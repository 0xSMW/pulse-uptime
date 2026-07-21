import { Text } from "@react-email/components"
import { EmailLayout, emailMetaStyle, emailTextStyle } from "./layout"

export interface SystemAlertEmailProps {
  title: string
  detail: string
  reason: string
  detectedAt: string
}

export function SystemAlertEmail({
  title,
  detail,
  reason,
  detectedAt,
}: SystemAlertEmailProps) {
  return (
    <EmailLayout heading={title} preview={title}>
      <Text style={emailMetaStyle}>Detected {detectedAt}</Text>
      <Text style={emailTextStyle}>{detail}</Text>
      <Text style={emailMetaStyle}>Reason: {reason}</Text>
    </EmailLayout>
  )
}

// biome-ignore lint/complexity/noRedundantDefaultExport: react-email preview server discovers the default export, named export is used by the app
export default SystemAlertEmail
