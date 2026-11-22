import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

import ts from "typescript"
import { describe, expect, it } from "vitest"

const appRoot = join(process.cwd(), "app")
const sourceRoots = ["app", "components", "lib"].map((directory) =>
  join(process.cwd(), directory)
)
const methods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
])

const expectedNonV1Operations = [
  "POST /api/auth/join",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "GET /api/cron/check-dependencies",
  "GET /api/cron/check-domains",
  "GET /api/cron/check-monitors",
  "GET /api/cron/deploy-proof",
  "GET /api/cron/maintenance",
  "GET /api/cron/sweep",
  "GET /api/health",
  "POST /api/onboarding/account",
  "POST /api/onboarding/activate",
  "POST /api/onboarding/back",
  "POST /api/onboarding/complete",
  "POST /api/onboarding/draft",
  "GET /api/onboarding/readiness",
  "POST /api/onboarding/verify",
  "POST /api/webhooks/porkbun",
  "GET /openapi/v1.json",
  "GET /status/assets/{imageId}",
  "GET /status/custom.css",
]

const expectedServerActions = [
  "app/cli/authorize/actions.ts:approveAuthorization",
  "app/cli/authorize/actions.ts:denyAuthorization",
  "app/cli/authorize/actions.ts:lookupAuthorization",
  "components/status-page/load-public-report-updates.ts:loadPublicReportUpdates",
]

function sourceFile(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

function exportedNames(source: ts.SourceFile): string[] {
  const names: string[] = []
  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      names.push(
        ...statement.exportClause.elements.map((element) => element.name.text)
      )
      continue
    }
    if (!ts.canHaveModifiers(statement)) {
      continue
    }
    const exported = ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) {
      continue
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.push(statement.name.text)
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text)
        }
      }
    }
  }
  return names
}

function applicationSourceFiles(): string[] {
  return sourceRoots.flatMap((root) =>
    (readdirSync(root, { recursive: true }) as string[])
      .filter((path) => /\.(?:ts|tsx)$/.test(path))
      .map((path) => join(root, path))
  )
}

function publicRoutePath(path: string): string {
  const directory = relative(appRoot, join(path, ".."))
  const segments = directory
    .split(sep)
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .map((segment) => segment.replace(/^\[(.+)\]$/, "{$1}"))
  return `/${segments.join("/")}`
}

describe("public entry-point inventory outside the v1 API", () => {
  it("registers every non-v1 HTTP route operation", () => {
    const operations = applicationSourceFiles()
      .filter((path) => path.startsWith(`${appRoot}${sep}`))
      .filter((path) => path.endsWith(`${sep}route.ts`))
      .filter((path) => !path.includes(`${sep}api${sep}v1${sep}`))
      .flatMap((path) =>
        exportedNames(sourceFile(path))
          .filter((name) => methods.has(name))
          .map((name) => `${name} ${publicRoutePath(path)}`)
      )
    expect(operations.sort()).toEqual(expectedNonV1Operations.sort())
  })

  it("registers every module-level Server Action", () => {
    const actions = applicationSourceFiles().flatMap((path) => {
      const source = sourceFile(path)
      const serverDirective = source.statements.some(
        (statement) =>
          ts.isExpressionStatement(statement) &&
          ts.isStringLiteral(statement.expression) &&
          statement.expression.text === "use server"
      )
      return serverDirective
        ? exportedNames(source).map(
            (name) =>
              `${relative(process.cwd(), path).split(sep).join("/")}:${name}`
          )
        : []
    })
    expect(actions.sort()).toEqual(expectedServerActions.sort())
  })

  it("has no inline Server Actions outside the inventory", () => {
    const inline: string[] = []
    for (const path of applicationSourceFiles()) {
      const source = sourceFile(path)
      function visit(node: ts.Node): void {
        if (
          node.parent !== source &&
          ts.isExpressionStatement(node) &&
          ts.isStringLiteral(node.expression) &&
          node.expression.text === "use server"
        ) {
          inline.push(relative(process.cwd(), path).split(sep).join("/"))
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(inline).toEqual([])
  })
})
