import { Text } from "@react-email/components";
import { EmailLayout, emailTextStyle } from "./layout";

export interface TestEmailProps {
  installationName?: string;
}

export function TestEmail({ installationName = "Pulse Uptime" }: TestEmailProps) {
  return (
    <EmailLayout preview="Test notification delivered" heading="Notifications are working">
      <Text style={emailTextStyle}>
        {installationName} can deliver outage and recovery alerts
      </Text>
    </EmailLayout>
  );
}

export default TestEmail;
