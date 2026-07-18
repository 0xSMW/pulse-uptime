import { Text } from "@react-email/components";
import { EmailLayout, emailMetaStyle, emailTextStyle } from "./layout";

export interface OutageEmailProps {
  monitorName: string;
  incidentUrl: string;
  startedAt: string;
  cause: string;
}

export function OutageEmail({ monitorName, incidentUrl, startedAt, cause }: OutageEmailProps) {
  return (
    <EmailLayout
      preview={`${monitorName} is down`}
      heading={`${monitorName} is down`}
      action={{ label: "View incident", url: incidentUrl }}
    >
      <Text style={emailTextStyle}>Pulse confirmed an outage after repeated failed checks</Text>
      <Text style={emailMetaStyle}>Started {startedAt}</Text>
      <Text style={emailMetaStyle}>Cause {cause}</Text>
    </EmailLayout>
  );
}

export default OutageEmail;
