/**
 * Workflow run timing harness.
 *
 * Reads the OpenFox sessions database and reports, per workflow run:
 *   - wall-clock duration (created_at → updated_at)
 *   - the number of LLM rounds (context.state events — one per completed call)
 *   - the number of tool calls
 *   - the number of criteria the run carried
 *   - the cached system-prompt size for the session (proxy for per-call prompt cost)
 *
 * This is the objective measurement behind the "a 30-criteria Build & Verify run
 * completes in < 60 min" acceptance criterion. Run it before and after a change
 * to compare:
 *
 *   npx tsx scripts/measure-workflow-runs.ts
 *   npx tsx scripts/measure-workflow-runs.ts --workflow default --min-criteria 20
 *   npx tsx scripts/measure-workflow-runs.ts --json
 *
 * It is read-only: it opens the DB in SQLite read-only mode and never writes.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { getDatabasePath } from '../src/cli/paths.js'
import type { Mode } from '../src/cli/paths.js'

export interface RunRow {
  session_id: string
  workflow_id: string
  workflow_name: string
  status: string
  created_at: number
  updated_at: number
}

export interface RunReport {
  sessionId: string
  workflowId: string
  workflowName: string
  status: string
  durationMin: number
  llmRounds: number
  toolCalls: number
  criteria: number
  cachedPromptChars: number
  maxTurnsHit: boolean
}

export interface RunSummary {
  count: number
  medianMin: number
  maxMin: number
  under60: number
}

export interface ParsedArgs {
  workflow?: string
  minCriteria?: number
  json: boolean
  limit: number
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { json: false, limit: 25 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--workflow') out.workflow = argv[++i]
    else if (a === '--min-criteria') out.minCriteria = Number(argv[++i])
    else if (a === '--limit') out.limit = Number(argv[++i])
  }
  return out
}

export function durationMin(row: Pick<RunRow, 'created_at' | 'updated_at'>): number {
  if (row.created_at == null || row.updated_at == null) return 0
  return Math.round(((row.updated_at - row.created_at) / 60000) * 10) / 10
}

/** Summarize the criteria-bearing runs (median / max duration, count under 60 min). */
export function summarize(runs: RunReport[]): RunSummary {
  const withCriteria = runs.filter((r) => r.criteria > 0)
  if (withCriteria.length === 0) return { count: 0, medianMin: 0, maxMin: 0, under60: 0 }
  const durs = withCriteria.map((r) => r.durationMin).sort((a, b) => a - b)
  const medianMin = durs[Math.floor(durs.length / 2)] ?? 0
  return {
    count: withCriteria.length,
    medianMin,
    maxMin: durs[durs.length - 1] ?? 0,
    under60: withCriteria.filter((r) => r.durationMin < 60).length,
  }
}

/**
 * Project a run's duration once the loop cap is enforced.
 *
 * A run whose LLM rounds exceed the cap would have stopped at `cap`, so its
 * duration is scaled by `cap / llmRounds` (rounds are the dominant cost, each
 * carrying the same system prompt). Runs already under the cap are unchanged.
 * `promptRatio` further scales for a reduced per-call prompt (e.g. the 0.21
 * achieved by trimming AGENTS.md) — 1 by default (no prompt change).
 */
export function projectDuration(report: RunReport, cap: number, promptRatio = 1): number {
  const rounds = report.llmRounds
  if (rounds <= 0) return report.durationMin * promptRatio
  const cappedRounds = cap > 0 && rounds > cap ? cap : rounds
  return Math.round(report.durationMin * (cappedRounds / rounds) * promptRatio * 10) / 10
}

function countEvents(db: DatabaseSync, sessionId: string, type: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND event_type = ?')
    .get(sessionId, type) as { n: number } | undefined
  return row?.n ?? 0
}

function maxCriteria(db: DatabaseSync, sessionId: string): number {
  // Criteria live in metadata.set payloads (JSON); count the largest array.
  const rows = db
    .prepare("SELECT payload FROM events WHERE session_id = ? AND event_type = 'metadata.set'")
    .all(sessionId) as { payload: string }[]
  let max = 0
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as { key?: string; entries?: unknown[] }
      if (p.key === 'criteria' && Array.isArray(p.entries)) max = Math.max(max, p.entries.length)
    } catch {
      /* ignore malformed payloads */
    }
  }
  return max
}

function maxTurnsHit(db: DatabaseSync, sessionId: string): boolean {
  const rows = db
    .prepare("SELECT payload FROM events WHERE session_id = ? AND event_type = 'message.start'")
    .all(sessionId) as { payload: string }[]
  return rows.some((r) => r.payload.includes('round limit'))
}

function cachedPromptChars(db: DatabaseSync, sessionId: string): number {
  const row = db.prepare('SELECT LENGTH(cached_system_prompt) AS n FROM sessions WHERE id = ?').get(sessionId) as
    { n: number | null } | undefined
  return row?.n ?? 0
}

export function buildReports(db: DatabaseSync, opts: ParsedArgs): RunReport[] {
  let sql = 'SELECT session_id, workflow_id, workflow_name, status, created_at, updated_at FROM workflow_executions'
  const params: unknown[] = []
  if (opts.workflow) {
    sql += ' WHERE workflow_id = ?'
    params.push(opts.workflow)
  }
  sql += ' ORDER BY created_at DESC'
  const runs = db.prepare(sql).all(...params) as RunRow[]

  const reports: RunReport[] = []
  for (const r of runs) {
    const report: RunReport = {
      sessionId: r.session_id,
      workflowId: r.workflow_id,
      workflowName: r.workflow_name,
      status: r.status,
      durationMin: durationMin(r),
      llmRounds: countEvents(db, r.session_id, 'context.state'),
      toolCalls: countEvents(db, r.session_id, 'tool.call'),
      criteria: maxCriteria(db, r.session_id),
      cachedPromptChars: cachedPromptChars(db, r.session_id),
      maxTurnsHit: maxTurnsHit(db, r.session_id),
    }
    if (opts.minCriteria !== undefined && report.criteria < opts.minCriteria) continue
    reports.push(report)
  }
  return reports
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  const dbPath =
    process.env['OPENFOX_DB_PATH'] ?? getDatabasePath((process.env['OPENFOX_MODE'] as Mode) ?? 'production')
  if (!existsSync(dbPath)) {
    console.error(`No sessions database at ${dbPath}`)
    process.exit(1)
  }

  const db = new DatabaseSync(dbPath, { readOnly: true })
  const reports = buildReports(db, opts)
  db.close()

  const shown = reports.slice(0, opts.limit)

  if (opts.json) {
    console.log(JSON.stringify(shown, null, 2))
    return
  }

  console.log(`\nWorkflow runs (${reports.length} matched${opts.workflow ? `, workflow=${opts.workflow}` : ''})`)
  console.log('duration   llmRounds  tools  criteria  promptChars  maxTurns  status      workflow')
  for (const r of shown) {
    console.log(
      `${r.durationMin.toString().padStart(7)}min ` +
        `${r.llmRounds.toString().padStart(9)} ` +
        `${r.toolCalls.toString().padStart(6)} ` +
        `${r.criteria.toString().padStart(9)} ` +
        `${r.cachedPromptChars.toString().padStart(12)} ` +
        `${(r.maxTurnsHit ? 'yes' : 'no').padStart(9)} ` +
        `${r.status.padEnd(11)} ${r.workflowName}`,
    )
  }

  const s = summarize(reports)
  if (s.count > 0) {
    console.log(
      `\nCriteria-bearing runs: ${s.count} | median ${s.medianMin}min | max ${s.maxMin}min | ${s.under60}/${s.count} under 60min`,
    )
    const cap = Number(process.env['MAX_TURNS'] ?? 100)
    const ratio = Number(process.env['PROMPT_RATIO'] ?? 0.21)
    const projected = reports
      .filter((r) => r.criteria > 0)
      .map((r) => projectDuration(r, cap, ratio))
      .sort((a, b) => a - b)
    if (projected.length > 0) {
      const pMedian = projected[Math.floor(projected.length / 2)] ?? 0
      const pUnder60 = projected.filter((d) => d < 60).length
      console.log(
        `Projected with maxTurns=${cap}, promptRatio=${ratio}: median ${pMedian}min | ` +
          `${pUnder60}/${projected.length} under 60min`,
      )
    }
  }
}

// Run only when executed directly (not when imported by a test).
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
