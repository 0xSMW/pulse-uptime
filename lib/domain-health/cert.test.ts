import { EventEmitter } from "node:events"
import type { TLSSocket } from "node:tls"
import { describe, expect, it, vi } from "vitest"

import { probeCertificate, type TlsConnector } from "./cert"

interface FakeSocketOptions {
  remoteAddress?: string
  certificate?: Record<string, unknown> | null
}

function fakeSocket(options: FakeSocketOptions = {}) {
  const socket = new EventEmitter() as EventEmitter & {
    remoteAddress?: string
    destroy: ReturnType<typeof vi.fn>
    getPeerCertificate: ReturnType<typeof vi.fn>
  }
  socket.remoteAddress = options.remoteAddress
  socket.destroy = vi.fn()
  socket.getPeerCertificate = vi.fn(() => options.certificate)
  return socket
}

function connectorFor(
  socket: ReturnType<typeof fakeSocket>,
  behavior: "secure" | "error" | "timeout" | "silent" = "secure"
): TlsConnector {
  return ((_options, onSecureConnect) => {
    queueMicrotask(() => {
      if (behavior === "secure") {
        onSecureConnect()
      } else if (behavior === "error") {
        socket.emit("error", new Error("handshake failed"))
      } else if (behavior === "timeout") {
        socket.emit("timeout")
      }
    })
    return socket as unknown as TLSSocket
  }) as TlsConnector
}

const validCertificate = {
  valid_to: "Oct 12 00:00:00 2026 GMT",
  issuer: { O: "Let's Encrypt" },
}

describe("probeCertificate", () => {
  it("reads expiry and issuer from the peer certificate and closes the socket", async () => {
    const socket = fakeSocket({
      remoteAddress: "93.184.216.34",
      certificate: validCertificate,
    })
    const facts = await probeCertificate(
      "example.com",
      443,
      connectorFor(socket)
    )
    expect(facts.expiresAt?.toISOString()).toBe("2026-10-12T00:00:00.000Z")
    expect(facts.issuer).toBe("Let's Encrypt")
    expect(socket.destroy).toHaveBeenCalled()
  })

  it("strips control characters from a hostile issuer name", async () => {
    const socket = fakeSocket({
      remoteAddress: "93.184.216.34",
      certificate: {
        valid_to: "Oct 12 00:00:00 2026 GMT",
        issuer: { O: "Evil[2JCorp" },
      },
    })
    const facts = await probeCertificate(
      "example.com",
      443,
      connectorFor(socket)
    )
    expect(facts.issuer).toBe("Evil[2JCorp")
  })

  it("returns null facts on a handshake error", async () => {
    const socket = fakeSocket()
    const facts = await probeCertificate(
      "example.com",
      443,
      connectorFor(socket, "error")
    )
    expect(facts).toEqual({ expiresAt: null, issuer: null })
    expect(socket.destroy).toHaveBeenCalled()
  })

  it("returns null facts on a socket timeout", async () => {
    const socket = fakeSocket()
    const facts = await probeCertificate(
      "example.com",
      443,
      connectorFor(socket, "timeout")
    )
    expect(facts).toEqual({ expiresAt: null, issuer: null })
  })

  it("refuses a connected peer on a private address", async () => {
    const socket = fakeSocket({
      remoteAddress: "127.0.0.1",
      certificate: validCertificate,
    })
    const facts = await probeCertificate(
      "example.com",
      443,
      connectorFor(socket)
    )
    expect(facts).toEqual({ expiresAt: null, issuer: null })
    expect(socket.destroy).toHaveBeenCalled()
  })

  it("returns null facts when the connector throws synchronously", async () => {
    const connect: TlsConnector = () => {
      throw new Error("no route")
    }
    const facts = await probeCertificate("example.com", 443, connect)
    expect(facts).toEqual({ expiresAt: null, issuer: null })
  })

  it("keeps the issuer when the expiry date is unparseable", async () => {
    const socket = fakeSocket({
      remoteAddress: "93.184.216.34",
      certificate: { valid_to: "never", issuer: { O: "Example CA" } },
    })
    const facts = await probeCertificate(
      "example.com",
      443,
      connectorFor(socket)
    )
    expect(facts.expiresAt).toBeNull()
    expect(facts.issuer).toBe("Example CA")
  })

  it("settles exactly once when an error follows the handshake", async () => {
    const socket = fakeSocket({
      remoteAddress: "93.184.216.34",
      certificate: validCertificate,
    })
    const connect: TlsConnector = ((_options, onSecureConnect) => {
      queueMicrotask(() => {
        onSecureConnect()
        socket.emit("error", new Error("late reset"))
      })
      return socket as unknown as TLSSocket
    }) as TlsConnector
    const facts = await probeCertificate("example.com", 443, connect)
    expect(facts.issuer).toBe("Let's Encrypt")
  })
})
