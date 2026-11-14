/**
 * Benchmark: the context-window lookup hot path.
 *
 * The question it answers: how long does it take to recover the current
 * context window id of a session whose latest snapshot is huge?
 *
 * Two paths are measured on the SAME synthetic database:
 *
 * - `legacy` — the original implementation: read the window-changing events
 *   and JSON-parse their payloads (`foldContextState` over
 *   `getContextWindowEvents`). A snapshot payload is dominated by its
 *   `messages` array, so this scales with the snapshot size.
 * - `fast` — the current implementation: an index-only lookup in the
 *   `event_context_window` side table.
 *
 * The database is synthetic and disposable: it is built in a temp directory
 * and deleted at the end. No real database is ever opened.
 *
 * Usage:
 *   npm run bench:context-window
 *   BENCH_CW_MESSAGES=5000 npm run bench:context-window   # bigger snapshot
 *   BENCH_CW_ITERATIONS=50 npm run bench:context-window   # more samples
 */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventStore } from '../../src/server/events/store.js'
import { foldContextState } from '../../src/server/events/folding.js'
import type { SessionSnapshot } from '../../src/server/events/types.js'

const MESSAGES = Number(process.env['BENCH_CW_MESSAGES'] ?? 1761)
const MESSAGE_CHARS = Number(process.env['BENCH_CW_MESSAGE_CHARS'] ?? 12_000)
const ITERATIONS = Number(process.env['BENCH_CW_ITERATIONS'] ?? 20)
/** Sessions with a snapshot but NO side-table row — the legacy-database case. */
const LEGACY_SESSIONS = Number(process.env['BENCH_CW_LEGACY_SESSIONS'] ?? 3)

/** A snapshot payload of roughly the size seen in the wild (tens of MB). */
function buildSnapshotPayload(windowId: string): string {
  const messages = Array.from({ length: MESSAGES }, (_, i) => ({
    id: `m${i}`,
    role: 'assistant' as const,
    content: 'x'.repeat(MESSAGE_CHARS),
    timestamp: 1_700_000_000_000 + i,
    toolCalls: [],
  }))

  const snapshot: SessionSnapshot = {
    mode: 'planner',
    phase: 'plan',
    isRunning: false,
    messages,
    criteria: [],
    metadataEntries: {},
    contextState: {
      currentTokens: 10,
      maxTokens: 200_000,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    },
    currentContextWindowId: windowId,
    todos: [],
    readFiles: [],
    snapshotSeq: 2,
    snapshotAt: 1_700_000_000_000,
  }

  return JSON.stringify(snapshot)
}

/**
 * Build the disposable database.
 *
 * Sessions `bench-N` get their side-table rows (the normal, current state).
 * Sessions `legacy-N` get their events inserted directly into `events`, with
 * NO side-table row — exactly what a database created before the side table
 * existed looks like.
 */
function buildDatabase(dbPath: string): { db: Database.Database } {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(session_id, seq)
    )
  `)
  db.exec(`CREATE INDEX idx_events_session_type_seq ON events(session_id, event_type, seq)`)

  const insertEvent = db.prepare(
    `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, ?, ?, ?, ?)`,
  )

  // The side table is created by EventStore.initSchema() — build the store
  // first so the schema is in place, then insert the legacy rows by hand.
  const store = new EventStore(db)

  for (let i = 0; i < LEGACY_SESSIONS; i++) {
    const sessionId = `legacy-${i}`
    insertEvent.run(
      sessionId,
      1,
      Date.now(),
      'session.initialized',
      JSON.stringify({ projectId: 'p', workdir: '/tmp', contextWindowId: `window-${i}` }),
    )
    insertEvent.run(sessionId, 2, Date.now(), 'turn.snapshot', buildSnapshotPayload(`window-${i}`))
  }

  for (let i = 0; i < 1; i++) {
    const sessionId = `bench-${i}`
    store.append(sessionId, {
      type: 'session.initialized',
      data: { projectId: 'p', workdir: '/tmp', contextWindowId: `window-${i}` },
    })
    store.append(sessionId, {
      type: 'turn.snapshot',
      data: JSON.parse(buildSnapshotPayload(`window-${i}`)),
    })
  }

  return { db }
}

/** Median of the samples — robust against a single GC pause. */
function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function measure(label: string, fn: () => void, iterations: number): number {
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    fn()
    samples.push(performance.now() - start)
  }
  const med = median(samples)
  console.log(
    `  ${label.padEnd(42)} median ${med.toFixed(2).padStart(8)} ms   ` +
      `min ${Math.min(...samples)
        .toFixed(2)
        .padStart(8)} ms   max ${Math.max(...samples)
        .toFixed(2)
        .padStart(8)} ms`,
  )
  return med
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'openfox-bench-cw-'))
  const dbPath = join(dir, 'bench.db')
  let db: Database.Database | undefined

  try {
    const built = buildDatabase(dbPath)
    db = built.db
    const store = new EventStore(db)

    const payloadBytes = (
      db.prepare(`SELECT LENGTH(payload) AS n FROM events WHERE event_type = 'turn.snapshot' LIMIT 1`).get() as {
        n: number
      }
    ).n

    console.log('Context-window lookup benchmark')
    console.log(`  synthetic snapshot: ${MESSAGES} messages, ${(payloadBytes / 1048576).toFixed(1)} MiB payload`)
    console.log(`  iterations: ${ITERATIONS}\n`)

    const benchSession = 'bench-0'
    const legacySession = 'legacy-0'

    // Warm the parsed-snapshot cache of the legacy path so the comparison is
    // about the payload read, not about a cold cache.
    foldContextState(store.getContextWindowEvents(benchSession), '')

    console.log('current session (side table populated):')
    const legacyMs = measure(
      'legacy — fold over parsed payloads',
      () => {
        foldContextState(store.getContextWindowEvents(benchSession), '')
      },
      ITERATIONS,
    )
    const fastMs = measure(
      'fast — side table lookup',
      () => {
        store.getCurrentContextWindowId(benchSession)
      },
      ITERATIONS,
    )

    console.log('\nlegacy session (no side-table row — first access):')
    const legacyFirstMs = measure(
      'legacy — first access (backfill + lookup)',
      () => {
        store.backfillContextWindows(legacySession)
        store.getCurrentContextWindowId(legacySession)
      },
      1,
    )
    const legacySteadyMs = measure(
      'fast — steady state after backfill',
      () => {
        store.getCurrentContextWindowId(legacySession)
      },
      ITERATIONS,
    )

    console.log('\nverdict:')
    console.log(`  speed-up on the hot path: ${(legacyMs / fastMs).toFixed(1)}x`)
    console.log(`  legacy first access (backfill): ${legacyFirstMs.toFixed(2)} ms`)
    console.log(`  legacy steady state: ${legacySteadyMs.toFixed(2)} ms`)
    if (fastMs > 10) {
      console.log(`  WARNING: the fast path is ${fastMs.toFixed(2)} ms — above the 10 ms target`)
    } else {
      console.log(`  OK: the fast path is below the 10 ms target`)
    }

    // ------------------------------------------------------------------------
    // Write path: appending ordinary events must stay exactly as cheap as
    // before the side table existed (no extra transaction per event).
    //
    // The reference is the HISTORICAL shape of `append()` for an ordinary
    // event: a bare INSERT, no explicit transaction. It is measured here so
    // the side table's write overhead is visible and not assumed.
    // ------------------------------------------------------------------------
    console.log('\nwrite path (ordinary events, no window change):')
    const appendDb = new Database(join(dir, 'append.db'))
    const appendStore = new EventStore(appendDb)
    const appendCount = Number(process.env['BENCH_CW_APPEND_EVENTS'] ?? 10_000)
    const deltas = Array.from({ length: 20 }, (_, i) => ({ messageId: 'm0', content: `chunk-${i}` }))

    const start = performance.now()
    for (let i = 0; i < appendCount; i++) {
      appendStore.append('append-session', {
        type: 'message.delta',
        data: deltas[i % deltas.length]!,
      })
    }
    const appendMs = performance.now() - start

    // Historical shape of `append()` for an ordinary event, replicated
    // faithfully: a fresh prepared statement per call (as the old code did),
    // the same `getNextSeq` probe, a bare INSERT — and NO transaction.
    const legacyStart = performance.now()
    for (let i = 0; i < appendCount; i++) {
      const legacyInsert = appendDb.prepare(
        `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, ?, ?, ?, ?)`,
      )
      const seqRow = appendDb
        .prepare(`SELECT MAX(seq) as max_seq FROM events WHERE session_id = ?`)
        .get('legacy-append-session') as { max_seq: number | null }
      legacyInsert.run(
        'legacy-append-session',
        (seqRow.max_seq ?? 0) + 1,
        Date.now(),
        'message.delta',
        JSON.stringify(deltas[i % deltas.length]),
      )
    }
    const legacyAppendMs = performance.now() - legacyStart

    const perEvent = (total: number): string => `${((total / appendCount) * 1000).toFixed(2).padStart(7)} µs`
    console.log(
      `  ${`${appendCount} appends — current store`.padEnd(42)} total ${appendMs.toFixed(2).padStart(8)} ms   ` +
        `per event ${perEvent(appendMs)}`,
    )
    console.log(
      `  ${`${appendCount} appends — historical shape`.padEnd(42)} total ${legacyAppendMs.toFixed(2).padStart(8)} ms   ` +
        `per event ${perEvent(legacyAppendMs)}`,
    )
    const overhead = appendMs - legacyAppendMs
    console.log(
      `  overhead of the current store: ${overhead >= 0 ? '+' : ''}${overhead.toFixed(2)} ms ` +
        `(${((overhead / legacyAppendMs) * 100).toFixed(1)}%)`,
    )
    appendDb.close()
  } finally {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

main()
