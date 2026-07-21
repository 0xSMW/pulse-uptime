// Resolve extensionless TypeScript imports for Node's native TypeScript support.
// Package scripts load this hook through register.mjs.

import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const CANDIDATE_EXTENSIONS = [".ts", "/index.ts"]

export function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../")
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(specifier)
  if (isRelative && !hasExtension && context.parentURL) {
    for (const extension of CANDIDATE_EXTENSIONS) {
      const candidateUrl = new URL(specifier + extension, context.parentURL)
      if (existsSync(fileURLToPath(candidateUrl))) {
        return nextResolve(specifier + extension, context)
      }
    }
  }
  return nextResolve(specifier, context)
}
