// Minimal Node ESM resolve hook so this tool's TypeScript sources can use
// the same extensionless relative-import style as the rest of the repo
// (matching the app's "moduleResolution": "bundler" tsconfig, which forbids
// explicit .ts extensions) while still running directly under Node's native
// TypeScript support, which requires fully-specified ESM specifiers.
//
// This intentionally lives entirely under scripts/query-performance/ so
// nothing outside this tool's own ownership needs to change (no tsconfig.json
// edits) — see the entry-point scripts in package.json, all of which run via
// `node --import ./scripts/query-performance/register.mjs ...`.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CANDIDATE_EXTENSIONS = [".ts", "/index.ts"];

export function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(specifier);
  if (isRelative && !hasExtension && context.parentURL) {
    for (const extension of CANDIDATE_EXTENSIONS) {
      const candidateUrl = new URL(specifier + extension, context.parentURL);
      if (existsSync(fileURLToPath(candidateUrl))) {
        return nextResolve(specifier + extension, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
