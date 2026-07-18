import { hashCanonical } from "./canonical";
import { exportDeclarativeConfig } from "./export";
import type { MonitoringConfig } from "./schema";
import { evaluateDestructiveChange, isValidDestructiveApproval, type DestructiveApproval } from "./tripwire";
import { validateMonitoringConfig } from "./validation";

export interface AcceptedConfigSnapshot {
  config: MonitoringConfig;
  hash: string;
}

export type AcceptanceResult =
  | {
      status: "accepted";
      config: MonitoringConfig;
      hash: string;
      fallbackUsed: false;
      approvalConsumed: boolean;
    }
  | {
      status: "rejected";
      reason: "INVALID_CONFIGURATION" | "DESTRUCTIVE_APPROVAL_REQUIRED";
      candidateHash: string | null;
      config: MonitoringConfig;
      hash: string;
      fallbackUsed: true;
    }
  | {
      status: "unavailable";
      reason: "INVALID_CONFIGURATION_WITHOUT_FALLBACK";
      candidateHash: null;
      config: null;
      hash: null;
      fallbackUsed: false;
    };

export interface AcceptanceOptions {
  approval?: DestructiveApproval | null;
  now?: Date;
}

export function evaluateConfigurationAcceptance(
  desiredInput: unknown,
  lastAccepted: AcceptedConfigSnapshot | null,
  options: AcceptanceOptions = {},
): AcceptanceResult {
  let desired: MonitoringConfig;
  try {
    desired = validateMonitoringConfig(desiredInput);
  } catch {
    if (!lastAccepted) {
      return {
        status: "unavailable", reason: "INVALID_CONFIGURATION_WITHOUT_FALLBACK",
        candidateHash: null, config: null, hash: null, fallbackUsed: false,
      };
    }
    return {
      status: "rejected", reason: "INVALID_CONFIGURATION", candidateHash: null,
      config: lastAccepted.config, hash: lastAccepted.hash, fallbackUsed: true,
    };
  }

  const candidateHash = hashCanonical(desired);
  if (!lastAccepted || candidateHash === lastAccepted.hash) {
    return { status: "accepted", config: desired, hash: candidateHash, fallbackUsed: false, approvalConsumed: false };
  }

  const destructive = evaluateDestructiveChange(
    exportDeclarativeConfig(lastAccepted.config),
    exportDeclarativeConfig(desired),
  );
  if (destructive.required && !isValidDestructiveApproval(options.approval, candidateHash, options.now)) {
    return {
      status: "rejected", reason: "DESTRUCTIVE_APPROVAL_REQUIRED", candidateHash,
      config: lastAccepted.config, hash: lastAccepted.hash, fallbackUsed: true,
    };
  }

  return {
    status: "accepted", config: desired, hash: candidateHash, fallbackUsed: false,
    approvalConsumed: destructive.required,
  };
}

