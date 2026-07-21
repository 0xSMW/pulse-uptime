import {
  type AcceptanceResult,
  type AcceptedConfigSnapshot,
  evaluateConfigurationAcceptance,
} from "@/lib/config/acceptance"

export async function evaluateConfigurationSource(options: {
  readDesired: () => Promise<unknown>
  previous: AcceptedConfigSnapshot | null
  now: Date
}): Promise<{
  desired: unknown
  result: AcceptanceResult
  sourceError: boolean
}> {
  let desired: unknown
  let sourceError = false
  try {
    desired = await options.readDesired()
    sourceError = desired === undefined || desired === null
  } catch {
    desired = undefined
    sourceError = true
  }
  return {
    desired,
    result: evaluateConfigurationAcceptance(desired, options.previous, {
      now: options.now,
    }),
    sourceError,
  }
}

export async function requireApprovalConsumption(options: {
  result: AcceptanceResult
  desired: unknown
  previous: AcceptedConfigSnapshot | null
  now: Date
  consume: () => Promise<boolean>
}): Promise<AcceptanceResult> {
  if (
    options.result.status !== "accepted" ||
    !options.result.approvalConsumed
  ) {
    return options.result
  }
  if (await options.consume()) {
    return options.result
  }
  return evaluateConfigurationAcceptance(options.desired, options.previous, {
    now: options.now,
  })
}
