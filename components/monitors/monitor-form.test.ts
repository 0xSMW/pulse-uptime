import { describe, expect, it } from "vitest"

import {
  type EditableMonitor,
  emptyNumericMonitorValues,
  monitorMutationBody,
  numericMonitorValidation,
  numericMonitorValues,
  stringMonitorValues,
  validateMonitorValues,
} from "./monitor-form"

const monitor: EditableMonitor = {
  id: "public-api",
  name: "Public API",
  url: "https://api.example.com/health",
  enabled: true,
  groupId: "production",
  group: "Production",
  method: "GET",
  intervalMinutes: 5,
  timeoutMs: 9000,
  expectedStatusMin: 201,
  expectedStatusMax: 398,
  failureThreshold: 3,
  recoveryThreshold: 4,
  recipients: ["ops@example.com", "owner@example.com"],
}

describe("monitor form adapters", () => {
  it("creates numeric values for the settings editor", () => {
    expect(numericMonitorValues(monitor)).toEqual({
      name: "Public API",
      url: "https://api.example.com/health",
      enabled: true,
      groupId: "production",
      method: "GET",
      intervalMinutes: 5,
      timeoutMs: 9000,
      expectedStatusMin: 201,
      expectedStatusMax: 398,
      failureThreshold: 3,
      recoveryThreshold: 4,
      recipientsText: "ops@example.com\nowner@example.com",
    })
  })

  it("creates string values for the detail editor", () => {
    expect(stringMonitorValues(monitor)).toEqual({
      name: "Public API",
      url: "https://api.example.com/health",
      enabled: true,
      groupId: "production",
      method: "GET",
      intervalMinutes: "5",
      timeoutMs: "9000",
      expectedStatusMin: "201",
      expectedStatusMax: "398",
      failureThreshold: "3",
      recoveryThreshold: "4",
      recipientsText: "ops@example.com\nowner@example.com",
    })
  })

  it("serializes numeric settings values and trims their URL", () => {
    expect(
      monitorMutationBody(
        {
          ...numericMonitorValues(monitor),
          name: "  Public API  ",
          url: "  https://api.example.com/health  ",
        },
        { trimUrl: true }
      )
    ).toEqual({
      name: "Public API",
      url: "https://api.example.com/health",
      enabled: true,
      groupId: "production",
      method: "GET",
      intervalMinutes: 5,
      timeoutMs: 9000,
      expectedStatus: { minimum: 201, maximum: 398 },
      failureThreshold: 3,
      recoveryThreshold: 4,
      recipients: ["ops@example.com", "owner@example.com"],
    })
  })

  it("coerces detail values and preserves their URL", () => {
    expect(
      monitorMutationBody(
        {
          ...stringMonitorValues(monitor),
          name: "  Public API  ",
          url: "  https://api.example.com/health  ",
        },
        { trimUrl: false }
      )
    ).toEqual({
      name: "Public API",
      url: "  https://api.example.com/health  ",
      enabled: true,
      groupId: "production",
      method: "GET",
      intervalMinutes: 5,
      timeoutMs: 9000,
      expectedStatus: { minimum: 201, maximum: 398 },
      failureThreshold: 3,
      recoveryThreshold: 4,
      recipients: ["ops@example.com", "owner@example.com"],
    })
  })

  it("keeps the numeric editor's low-minimum behavior", () => {
    const errors = validateMonitorValues(
      {
        ...emptyNumericMonitorValues,
        name: "API",
        url: "https://api.example.com",
        expectedStatusMin: 99,
        expectedStatusMax: 99,
      },
      numericMonitorValidation
    )

    expect(errors.expectedStatusMin).toBe("Enter 100–599")
    expect(errors.expectedStatusMax).toBeUndefined()
  })
})
