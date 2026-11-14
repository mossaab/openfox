#!/usr/bin/env node
/**
 * Benchmark: the context-window lookup on a REAL historical database.
 *
 * This is the administrator-run counterpart of `context-window.ts`. It measures
 * the two implementations of "what is the current context window of this
 * session?" against a real session database:
 *
 * - `legacy` — the original: read the window-changing events and JSON-parse
 *   their payloads (`foldContextState` over `getContextWindowEvents`).
 * - `fast`   — the current one: an index-only lookup in the
 *   `event_context_window` side table.
 *
 * SAFETY MODEL — this script is deliberately paranoid:
 *
 * - The source database is **never opened**. It is copied, byte for byte,
 *   into a disposable work copy, and only the copy is ever opened.
 * - The source file is verified before AND after the run (size + mtime) to
 *   prove it was not modified.
 * - The work directory must not exist yet (no accidental reuse), and must not
 *   be the source directory.
 * - The new table and its index are created ONLY in the work copy.
 * - `initDatabase()` is never called: the harness opens the copy with
 *   better-sqlite3 directly, so no active OpenFox configuration is read and
 *   no server is started.
 * - No conversation content is ever printed — only session ids, timings and
 *   counts.
 *
 * Usage (run as the administrator, on the machine that holds the database):
 *
 *   npx tsx scripts/bench/context-window-real.ts \
 *     --source /root/openfox-benchmark/pr401-indexes-working.db \
 *     --work   /root/openfox-benchmark/cw-run-<timestamp>
 *
 * Options:
 *   --source <file>   the real database to copy (read-only, never opened)
 *   --work <dir>      the disposable directory to create the copy in
 *   --sessions <ids>  comma-separated session ids to report on (default: the
 *                     known slow ones)
 *   --all             measure every session that has events
 *   --limit <n>       cap the number of sessions measured (default: 25)
 *   --keep            keep the work directory instead of deleting it
 */
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { EventStore } from '../../src/server/events/store.js'
import { foldContextState } from '../../src/server/events/folding.js'

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Options {
  source: string
  work: string
  sessions: string[]
  all: boolean
  limit: number
  keep: boolean
}

const DEFAULT_SESSIONS = ['810af208', 'e5011a3f', 'e8fd1729']

function parseArgs(argv: string[]): Options {
  let source: string | undefined
  let work: string | undefined
  let sessions: string[] = [...DEFAULT_SESSIONS]
  let all = false
  let limit = 25
  let keep = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--source':
        source = argv[++i]
        break
      case '--work':
        work = argv[++i]
        break
      case '--sessions':
        sessions = argv[++i]!.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        break
      case '--all':
        all = true
        break
      case '--limit':
        limit = Number(argv[++i])
        break
      case '--keep':
        keep = true
        break
      case '--help':
      case '-h':
        console.log(
          'Usage: tsx scripts/bench/context-window-real.ts --source <db> --work <dir> ' +
            '[--sessions a,b,c] [--all] [--limit n] [--keep]',
        )
        process.exit(0)
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!source) throw new Error('--source <db> is required')
  if (!work) throw new Error('--work <dir> is required')
  return {
    source: resolve(source),
    work: resolve(work),
    sessions,
    all,
    limit,
    keep,
  }
}

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------

interface FileStamp {
  size: number
  mtimeMs: number
}

function stamp(path: string): FileStamp {
  const stat = statSync(path)
  return { size: stat.size, mtimeMs: stat.mtimeMs }
}

function assertSafe(options: Options): void {
  if (!existsSync(options.source)) {
    throw new Error(`Source database does not exist: ${options.source}`)
  }
  if (existsSync(options.work)) {
    throw new Error(
      `Work directory already exists: ${options.work}\n` +
        'Refusing to reuse it — choose a fresh path so no stale copy is measured.',
    )
  }
  const sourceDir = resolve(options.source, '..')
  const workDir = resolve(options.work)
  if (sourceDir === workDir) {
    throw new Error('--work must differ from the source directory (the source is never modified).')
  }
  if (resolve(options.source) === resolve(options.work)) {
    throw new Error('--work must differ from --source.')
  }
}

/** SQLite integrity check on the WORK copy only. */
function quickCheck(db: Database.Database): string {
  const rows = db.pragma('quick_check') as Array<{ quick_check: string }>
  return rows.map((row) => row.quick_check).join('; ')
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface Row {
  sessionId: string
  events: number
  snapshots: number
  snapshotBytes: number
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function fmtMs(ms: number): string {
  return ms.toFixed(2).padStart(9)
}

/**
 * The legacy getter: the exact code the patch replaced.
 */
function legacyGetter(store: EventStore, sessionId: string): string | undefined {
  const folded = foldContextState(store.getContextWindowEvents(sessionId), '')
  return folded.currentContextWindowId || undefined
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  assertSafe(options)

  console.log('Context-window benchmark on a REAL database copy')
  console.log(`  source (never opened): ${options.source}`)
  console.log(`  work (disposable):     ${options.work}`)
  console.log('')

  // --- 1. Snapshot the source BEFORE anything else ------------------------
  const sourceBefore = stamp(options.source)
  console.log(`  source before: size=${sourceBefore.size} mtime=${sourceBefore.mtimeMs}`)

  // --- 2. Create the work copy --------------------------------------------
  mkdirSync(options.work, { recursive: false })
  const workDbPath = join(options.work, 'events.db')
  copyFileSync(options.source, workDbPath)
  const copyStamp = stamp(workDbPath)
  console.log(`  copied to:             ${workDbPath} (size=${copyStamp.size})`)

  let db: Database.Database | undefined
  try {
    // --- 3. Open the COPY only ---------------------------------------------
    db = new Database(workDbPath)
    db.pragma('journal_mode = WAL')

    const integrity = quickCheck(db)
    console.log(`  quick_check (copy):    ${integrity}`)

    const store = new EventStore(db)

    // --- 4. Which sessions to measure --------------------------------------
    const sessionRows = db
      .prepare(
        `SELECT session_id AS sessionId,
                COUNT(*) AS events,
                SUM(CASE WHEN event_type = 'turn.snapshot' THEN 1 ELSE 0 END) AS snapshots,
                SUM(CASE WHEN event_type = 'turn.snapshot' THEN LENGTH(payload) ELSE 0 END) AS snapshotBytes
         FROM events
         GROUP BY session_id
         ORDER BY snapshotBytes DESC`,
      )
      .all() as Row[]

    const byId = new Map(sessionRows.map((row) => [row.sessionId, row]))

    let targets: Row[]
    if (options.all) {
      targets = sessionRows.slice(0, options.limit)
    } else {
      targets = []
      for (const id of options.sessions) {
        const row = byId.get(id)
        if (row) {
          targets.push(row)
        } else {
          console.log(`  (session ${id} not present in this database)`)
        }
      }
    }

    if (targets.length === 0) {
      console.log('  nothing to measure')
      return
    }

    // --- 5. Legacy measurement (first — it populates the parsed cache) ------
    console.log('\n  legacy getter — foldContextState(getContextWindowEvents) — first access:')
    const legacyFirst: Array<{ id: string; ms: number; value: string | undefined }> = []
    for (const row of targets) {
      const start = performance.now()
      const value = legacyGetter(store, row.sessionId)
      const ms = performance.now() - start
      legacyFirst.push({ id: row.sessionId, ms, value })
      console.log(
        `    ${row.sessionId.padEnd(20)} ${fmtMs(ms)} ms   events=${String(row.events).padStart(7)} ` +
          `snapshots=${String(row.snapshots).padStart(2)} snapshotMiB=${(row.snapshotBytes / 1048576).toFixed(1)}`,
      )
    }

    // --- 6. Fast measurement ------------------------------------------------
    console.log('\n  fast getter — side table lookup — first access (legacy rows absent):')
    const fastFirst: Array<{ id: string; ms: number; value: string | undefined }> = []
    for (const row of targets) {
      const start = performance.now()
      const value = store.getCurrentContextWindowId(row.sessionId)
      const ms = performance.now() - start
      fastFirst.push({ id: row.sessionId, ms, value })
      console.log(`    ${row.sessionId.padEnd(20)} ${fmtMs(ms)} ms`)
    }

    // --- 7. Hot path (steady state) -----------------------------------------
    console.log('\n  fast getter — hot path (side table populated), median of 5:')
    for (const row of targets) {
      const samples: number[] = []
      for (let i = 0; i < 5; i++) {
        const start = performance.now()
        store.getCurrentContextWindowId(row.sessionId)
        samples.push(performance.now() - start)
      }
      console.log(`    ${row.sessionId.padEnd(20)} ${fmtMs(median(samples))} ms`)
    }

    // --- 8. Divergences -----------------------------------------------------
    let divergences = 0
    for (let i = 0; i < targets.length; i++) {
      const id = targets[i]!.sessionId
      const legacyValue = legacyFirst[i]!.value
      const fastValue = fastFirst[i]!.value
      if (legacyValue !== fastValue) {
        divergences++
        console.log(
          `    DIVERGENCE on ${id}: legacy=${legacyValue === undefined ? '<none>' : '<set>'} ` +
            `fast=${fastValue === undefined ? '<none>' : '<set>'}`,
        )
      }
    }
    console.log(`\n  divergences: ${divergences} / ${targets.length}`)

    // --- 9. Sessions without a snapshot -------------------------------------
    const noSnapshot = sessionRows.filter((row) => row.snapshots === 0).slice(0, 5)
    if (noSnapshot.length > 0) {
      console.log('\n  sessions without a snapshot:')
      for (const row of noSnapshot) {
        const start = performance.now()
        const value = store.getCurrentContextWindowId(row.sessionId)
        const ms = performance.now() - start
        const legacyValue = legacyGetter(store, row.sessionId)
        const agree = legacyValue === value
        console.log(
          `    ${row.sessionId.padEnd(20)} ${fmtMs(ms)} ms   events=${String(row.events).padStart(7)} ` +
            `window=${value === undefined ? '<none>' : '<set>'} ${agree ? 'agrees' : 'DIVERGES'}`,
        )
      }
    }

    // --- 10. Summary --------------------------------------------------------
    const legacyMedians = legacyFirst.map((entry) => entry.ms)
    const fastMedians = fastFirst.map((entry) => entry.ms)
    console.log('\n  summary:')
    console.log(`    legacy median: ${fmtMs(median(legacyMedians))} ms`)
    console.log(`    fast   median: ${fmtMs(median(fastMedians))} ms`)
    console.log(`    speed-up:      ${(median(legacyMedians) / Math.max(median(fastMedians), 0.001)).toFixed(1)}x`)
    console.log(`    divergences:   ${divergences}`)

    const copyIntegrity = quickCheck(db)
    console.log(`\n  quick_check (copy, after): ${copyIntegrity}`)
  } finally {
    db?.close()

    // --- 11. Prove the SOURCE was not touched -------------------------------
    const sourceAfter = stamp(options.source)
    const unchanged = sourceAfter.size === sourceBefore.size && sourceAfter.mtimeMs === sourceBefore.mtimeMs
    console.log(
      `  source after:  size=${sourceAfter.size} mtime=${sourceAfter.mtimeMs} ` +
        `-> ${unchanged ? 'UNCHANGED' : 'MODIFIED (ABORT!)'}`,
    )
    if (!unchanged) {
      throw new Error('The source database changed during the run — this is a bug in the harness.')
    }

    if (!options.keep) {
      rmSync(options.work, { recursive: true, force: true })
      console.log(`  work copy removed: ${options.work}`)
    } else {
      console.log(`  work copy kept:   ${options.work}`)
    }
  }
}

main()
