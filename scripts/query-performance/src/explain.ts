// Runs each query case through EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) with a
// warmup pass and N measured repeats, inside a transaction that always rolls
// back — so a `mutating: true` case (e.g. the outbox claim) never leaves the
// fixture in a different state between repeats or between benchmark runs.

import type postgres from "postgres";

import type { GatedConnection } from "./db-connection";
import type { QueryCase, ResolvedQuery } from "./query-cases";
import type { SampleContext } from "./sample-context";

export interface PlanNodeSummary {
  nodeType: string;
  actualTotalTimeMs: number;
  actualRows: number;
  actualLoops: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
}

export interface ExplainSample {
  totalTimeMs: number;
  planningTimeMs: number;
  executionTimeMs: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
  sharedDirtiedBlocks: number;
  sharedWrittenBlocks: number;
  rootRows: number;
  nodeCount: number;
  topNodes: PlanNodeSummary[];
}

export interface QueryCaseResult {
  name: string;
  description: string;
  source: string;
  mutating: boolean;
  paramShape: string;
  warmup: ExplainSample;
  samples: ExplainSample[];
}

// A sentinel thrown to force sql.begin() to roll back after EXPLAIN ANALYZE
// has already executed (and measured) the query's real side effects.
class IntentionalRollback extends Error {}

interface RawPlanNode {
  "Node Type": string;
  "Actual Total Time"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Plans"?: RawPlanNode[];
}

interface RawExplainOutput {
  Plan: RawPlanNode;
  "Planning Time": number;
  "Execution Time": number;
}

function flattenNodes(node: RawPlanNode, out: PlanNodeSummary[] = []): PlanNodeSummary[] {
  out.push({
    nodeType: node["Node Type"],
    actualTotalTimeMs: node["Actual Total Time"] ?? 0,
    actualRows: node["Actual Rows"] ?? 0,
    actualLoops: node["Actual Loops"] ?? 1,
    sharedHitBlocks: node["Shared Hit Blocks"] ?? 0,
    sharedReadBlocks: node["Shared Read Blocks"] ?? 0,
  });
  for (const child of node.Plans ?? []) flattenNodes(child, out);
  return out;
}

// conn.db = drizzle(conn.sql, ...) permanently replaces conn.sql's
// timestamp/timestamptz/json/jsonb serializers with an identity passthrough
// (drizzle pre-serializes those types itself before handing values to
// postgres.js). sql.unsafe() here goes around drizzle entirely, so a raw
// Date param would be hand to the wire protocol unserialized and crash --
// stringify it ourselves; Postgres coerces the resulting ISO string against
// whatever timestamp/timestamptz column or comparison it's bound to.
function serializeParam(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

async function explainOnce(sql: postgres.TransactionSql, query: ResolvedQuery): Promise<ExplainSample> {
  const text = `explain (analyze, buffers, format json) ${query.text}`;
  const rows = await sql.unsafe<{ "QUERY PLAN": [RawExplainOutput] }[]>(text, query.params.map(serializeParam) as never[]);
  const first = rows[0] as unknown as { "QUERY PLAN": [RawExplainOutput] } | undefined;
  const output = first?.["QUERY PLAN"]?.[0];
  if (!output) throw new Error(`EXPLAIN returned no plan for query: ${query.text.slice(0, 80)}...`);
  const nodes = flattenNodes(output.Plan);
  return {
    totalTimeMs: output["Planning Time"] + output["Execution Time"],
    planningTimeMs: output["Planning Time"],
    executionTimeMs: output["Execution Time"],
    sharedHitBlocks: nodes.reduce((sum, node) => sum + node.sharedHitBlocks, 0),
    sharedReadBlocks: nodes.reduce((sum, node) => sum + node.sharedReadBlocks, 0),
    sharedDirtiedBlocks: 0,
    sharedWrittenBlocks: 0,
    rootRows: output.Plan["Actual Rows"] ?? 0,
    nodeCount: nodes.length,
    topNodes: nodes.slice(0, 5),
  };
}

async function runInRolledBackTransaction<T>(sql: postgres.Sql, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await sql.begin(async (tx) => {
      result = await fn(tx);
      throw new IntentionalRollback();
    });
  } catch (error) {
    if (!(error instanceof IntentionalRollback)) throw error;
  }
  return result as T;
}

export interface RunOptions {
  warmupCount: number;
  repeatCount: number;
}

export async function runQueryCase(
  conn: GatedConnection,
  ctx: SampleContext,
  queryCase: QueryCase,
  options: RunOptions,
): Promise<QueryCaseResult> {
  const query = queryCase.build(conn, ctx);
  const warmup = await runInRolledBackTransaction(conn.sql, (tx) => explainOnce(tx, query));
  const samples: ExplainSample[] = [];
  for (let index = 0; index < options.repeatCount; index += 1) {
    samples.push(await runInRolledBackTransaction(conn.sql, (tx) => explainOnce(tx, query)));
  }
  return {
    name: queryCase.name,
    description: queryCase.description,
    source: queryCase.source,
    mutating: queryCase.mutating,
    paramShape: JSON.stringify(query.params.map((param) => (param instanceof Date ? "Date" : typeof param))),
    warmup,
    samples,
  };
}
