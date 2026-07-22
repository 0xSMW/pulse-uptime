import type { PeerCertificate, TLSSocket } from "node:tls"
import tls from "node:tls"

import {
  assertPublicAddress,
  normalizeIpLiteral,
} from "@/lib/checker/ip-policy"
import { createSecureLookup } from "@/lib/checker/secure-lookup"

import { sanitizeDisplayFact } from "./sanitize"

const CERT_PROBE_TIMEOUT_MS = 10_000

export interface CertificateFacts {
  expiresAt: Date | null
  issuer: string | null
}

export type TlsConnector = (
  options: tls.ConnectionOptions,
  onSecureConnect: () => void
) => TLSSocket

const defaultConnect: TlsConnector = (options, onSecureConnect) =>
  tls.connect(options, onSecureConnect)

function issuerName(certificate: PeerCertificate): string | null {
  const issuer = certificate.issuer
  if (!issuer || typeof issuer !== "object") {
    return null
  }
  const name = issuer.O || issuer.CN
  return typeof name === "string" ? sanitizeDisplayFact(name) : null
}

/**
 * One TLS handshake against hostname:port to read the leaf certificate's
 * expiry and issuer, then an immediate close. Verification is intentionally
 * off: an already-expired or misconfigured certificate must still report its
 * dates, and the scheduled availability check is what fails on TLS_ERROR.
 * Nothing is sent on the socket. DNS goes through the checker's secure lookup
 * so a private or rebinding target is refused exactly like a monitor check,
 * and the connected peer is re-validated after the handshake. All failures
 * degrade to null facts.
 */
export function probeCertificate(
  hostname: string,
  port: number,
  connect: TlsConnector = defaultConnect
): Promise<CertificateFacts> {
  const empty: CertificateFacts = { expiresAt: null, issuer: null }
  return new Promise((resolve) => {
    let socket: TLSSocket | undefined
    let settled = false
    const finish = (facts: CertificateFacts) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      resolve(facts)
    }
    const timer = setTimeout(() => finish(empty), CERT_PROBE_TIMEOUT_MS)
    try {
      socket = connect(
        {
          host: hostname,
          port,
          servername: hostname,
          rejectUnauthorized: false,
          lookup: createSecureLookup(),
          timeout: CERT_PROBE_TIMEOUT_MS,
        },
        () => {
          try {
            const remote = socket?.remoteAddress
            if (!(socket && remote)) {
              finish(empty)
              return
            }
            assertPublicAddress(normalizeIpLiteral(remote))
            const certificate = socket.getPeerCertificate()
            if (!certificate || typeof certificate.valid_to !== "string") {
              finish(empty)
              return
            }
            const expiresAt = new Date(certificate.valid_to)
            finish({
              expiresAt: Number.isNaN(expiresAt.getTime()) ? null : expiresAt,
              issuer: issuerName(certificate),
            })
          } catch {
            finish(empty)
          }
        }
      )
      socket.on("error", () => finish(empty))
      socket.on("timeout", () => finish(empty))
    } catch {
      finish(empty)
    }
  })
}
