import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components"
import type { ReactNode } from "react"

interface EmailLayoutProps {
  preview: string
  heading: string
  children: ReactNode
  action?: { label: string; url: string }
}

export function EmailLayout({
  preview,
  heading,
  children,
  action,
}: EmailLayoutProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.wordmark}>PULSE UPTIME</Text>
          <Heading style={styles.heading}>{heading}</Heading>
          <Section>{children}</Section>
          {action ? (
            <Button href={action.url} style={styles.button}>
              {action.label}
            </Button>
          ) : null}
          <Hr style={styles.rule} />
          <Text style={styles.footer}>Sent by Pulse Uptime</Text>
        </Container>
      </Body>
    </Html>
  )
}

export const emailTextStyle = {
  color: "#3f3f46",
  fontSize: "15px",
  lineHeight: "24px",
  margin: "0 0 14px",
}

export const emailMetaStyle = {
  color: "#71717a",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "13px",
  lineHeight: "20px",
  margin: "0 0 6px",
}

const styles = {
  body: {
    backgroundColor: "#f4f4f5",
    fontFamily: "Arial, sans-serif",
    margin: 0,
    padding: "32px 12px",
  },
  container: {
    backgroundColor: "#ffffff",
    border: "1px solid #e4e4e7",
    borderRadius: "12px",
    margin: "0 auto",
    maxWidth: "520px",
    padding: "32px",
  },
  wordmark: {
    color: "#71717a",
    fontSize: "11px",
    fontWeight: "700",
    letterSpacing: "0.12em",
    margin: "0 0 24px",
  },
  heading: {
    color: "#18181b",
    fontSize: "24px",
    lineHeight: "32px",
    margin: "0 0 18px",
  },
  button: {
    backgroundColor: "#18181b",
    borderRadius: "8px",
    color: "#ffffff",
    fontSize: "14px",
    fontWeight: "600",
    marginTop: "12px",
    padding: "11px 16px",
    textDecoration: "none",
  },
  rule: { borderColor: "#e4e4e7", margin: "30px 0 18px" },
  footer: { color: "#a1a1aa", fontSize: "12px", margin: 0 },
}
