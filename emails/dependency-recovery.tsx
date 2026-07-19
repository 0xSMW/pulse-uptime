import { Text } from "@react-email/components";
import { EmailLayout, emailMetaStyle, emailTextStyle } from "./layout";

export interface DependencyRecoveryEmailProps {
  dependencyName: string;
  provider: string;
  incidentTitle: string;
  state: string;
  canonicalUrl: string | null;
  providerTimestamp: string;
}

export function DependencyRecoveryEmail({
  dependencyName,
  provider,
  incidentTitle,
  state,
  canonicalUrl,
  providerTimestamp,
}: DependencyRecoveryEmailProps) {
  return (
    <EmailLayout
      preview={`${provider} resolved the incident affecting ${dependencyName}`}
      heading={`Provider resolved: ${dependencyName}`}
      action={canonicalUrl ? { label: "View provider incident", url: canonicalUrl } : undefined}
    >
      <Text style={emailTextStyle}>{provider} reports {incidentTitle} resolved</Text>
      <Text style={emailMetaStyle}>State {state}</Text>
      <Text style={emailMetaStyle}>Provider updated {providerTimestamp}</Text>
      <Text style={emailMetaStyle}>This reflects the provider&apos;s own status feed, not an independent Pulse check.</Text>
    </EmailLayout>
  );
}

export default DependencyRecoveryEmail;
