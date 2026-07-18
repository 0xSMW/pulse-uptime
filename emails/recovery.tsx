import { Text } from "@react-email/components";
import { EmailLayout, emailMetaStyle, emailTextStyle } from "./layout";

export interface RecoveryEmailProps {
  monitorName: string;
  incidentUrl: string;
  recoveredAt: string;
  duration: string;
}

export function RecoveryEmail({ monitorName, incidentUrl, recoveredAt, duration }: RecoveryEmailProps) {
  return (
    <EmailLayout
      preview={`${monitorName} recovered`}
      heading={`${monitorName} recovered`}
      action={{ label: "View incident", url: incidentUrl }}
    >
      <Text style={emailTextStyle}>Pulse confirmed the endpoint is responding again</Text>
      <Text style={emailMetaStyle}>Recovered {recoveredAt}</Text>
      <Text style={emailMetaStyle}>Duration {duration}</Text>
    </EmailLayout>
  );
}

export default RecoveryEmail;
