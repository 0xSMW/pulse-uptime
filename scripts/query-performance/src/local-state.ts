// Local, gitignored state for the query-performance benchmark harness.
// Everything here lives under `.query-performance/` at the repo root and is
// never committed (see .gitignore). This module is the ONLY place that reads
// that directory, so every other module gets its connection through here
// instead of touching process.env directly.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface TempProjectState {
  readonly marker: "query-performance-temp-project";
  readonly projectId: string;
  readonly projectName: string;
  readonly regionId: string;
  readonly createdAt: string;
  readonly database: string;
  readonly role: string;
  readonly host: string;
}

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const STATE_DIR = resolve(REPO_ROOT, ".query-performance");
const PROJECT_STATE_PATH = resolve(STATE_DIR, "project.json");
const CONNECTION_PATH = resolve(STATE_DIR, "connection.local");

export class LocalStateError extends Error {}

function readProjectState(): TempProjectState {
  let raw: string;
  try {
    raw = readFileSync(PROJECT_STATE_PATH, "utf8");
  } catch {
    throw new LocalStateError(
      `Missing ${PROJECT_STATE_PATH}. Run the migrate command after creating the temp Neon project.`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" || parsed === null ||
    !("projectId" in parsed) || typeof (parsed as { projectId: unknown }).projectId !== "string" ||
    !("projectName" in parsed) || typeof (parsed as { projectName: unknown }).projectName !== "string" ||
    !("host" in parsed) || typeof (parsed as { host: unknown }).host !== "string"
  ) {
    throw new LocalStateError(`${PROJECT_STATE_PATH} is missing required fields (projectId, projectName, host).`);
  }
  const candidate = parsed as Record<string, unknown>;
  return {
    marker: "query-performance-temp-project",
    projectId: candidate.projectId as string,
    projectName: candidate.projectName as string,
    regionId: String(candidate.regionId ?? ""),
    createdAt: String(candidate.createdAt ?? ""),
    database: String(candidate.database ?? ""),
    role: String(candidate.role ?? ""),
    host: candidate.host as string,
  };
}

function readConnectionString(): string {
  let raw: string;
  try {
    raw = readFileSync(CONNECTION_PATH, "utf8");
  } catch {
    throw new LocalStateError(
      `Missing ${CONNECTION_PATH}. Run the migrate command after creating the temp Neon project.`,
    );
  }
  const uri = raw.trim();
  if (!uri) throw new LocalStateError(`${CONNECTION_PATH} is empty.`);
  return uri;
}

/**
 * Loads the pinned temp-project connection. This is the single sanctioned
 * source of a database URL for every script in this tool — nothing here ever
 * reads DATABASE_URL / DATABASE_URL_UNPOOLED or accepts a URL as a CLI arg,
 * so there is no path from "arbitrary/production URL" to a live connection.
 */
export function loadTempProjectState(): { project: TempProjectState; connectionString: string } {
  const project = readProjectState();
  const connectionString = readConnectionString();
  let parsedHost: string;
  try {
    parsedHost = new URL(connectionString).hostname;
  } catch {
    throw new LocalStateError(`${CONNECTION_PATH} does not contain a parseable postgres connection URI.`);
  }
  if (parsedHost !== project.host) {
    throw new LocalStateError(
      "Connection string host does not match the recorded temp project host. Refusing to connect " +
        "(this check exists to prevent an edited/mismatched connection file from pointing anywhere " +
        "other than the pinned temp project).",
    );
  }
  return { project, connectionString };
}

export const paths = {
  stateDir: STATE_DIR,
  projectStatePath: PROJECT_STATE_PATH,
  connectionPath: CONNECTION_PATH,
} as const;
