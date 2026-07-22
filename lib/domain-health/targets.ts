import { apexDomain } from "./apex"

export interface DomainHealthMonitor {
  id: string
  url: string
}

export interface CertificateAssetTarget {
  hostname: string
  port: number
}

export interface MonitorDomainHealthTarget {
  id: string
  hostname: string
  apexDomain: string | null
  certificate: CertificateAssetTarget | null
}

export interface DomainHealthTargets {
  monitors: MonitorDomainHealthTarget[]
  apexDomains: string[]
  certificates: CertificateAssetTarget[]
}

export function certificateAssetKey(hostname: string, port: number): string {
  return `${hostname}\0${port}`
}

/**
 * Derives shared lookup identities from the accepted monitor configuration.
 * Callers pass every non-archived monitor, including disabled monitors.
 */
export function deriveDomainHealthTargets(
  monitors: readonly DomainHealthMonitor[]
): DomainHealthTargets {
  const derived: MonitorDomainHealthTarget[] = []
  const apexDomains = new Set<string>()
  const certificates = new Map<string, CertificateAssetTarget>()

  for (const monitor of monitors) {
    let url: URL
    try {
      url = new URL(monitor.url)
    } catch {
      continue
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      continue
    }

    const apex = apexDomain(url.hostname)
    if (apex) {
      apexDomains.add(apex)
    }
    const certificate =
      url.protocol === "https:"
        ? {
            hostname: url.hostname,
            port: url.port ? Number(url.port) : 443,
          }
        : null
    if (certificate) {
      certificates.set(
        certificateAssetKey(certificate.hostname, certificate.port),
        certificate
      )
    }
    derived.push({
      id: monitor.id,
      hostname: url.hostname,
      apexDomain: apex,
      certificate,
    })
  }

  return {
    monitors: derived,
    apexDomains: [...apexDomains],
    certificates: [...certificates.values()],
  }
}
