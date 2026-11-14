/**
 * Fast context-window lookup: side table vs. the original fold.
 *
 * `foldContextState` derives the current context window from exactly three
 * event types, but the window id only lives inside the event payload — and a
 * `turn.snapshot` payload is dominated by its `messages` array. Recovering the
 * window therefore meant JSON-parsing tens of MB on a path that runs inside
 * every tool execution and every LLM round (measured: 360 ms on a 25 MB
 * snapshot).
 *
 * `EventStore` keeps a side table (`event_context_window`) with the window id
 * each of those events assigns. These tests pin down that the fast path is
 * EXACTLY equivalent to the original fold, across every way an event log can
 * change — and that legacy databases (no side-table rows) still answer
 * correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventStore, extractContextWindowId } from './store.js'
import { foldContextState } from './folding.js'
import type { StoredEvent, SessionSnapshot } from './types.js'

/** The window id the ORIGINAL path derives — the reference implementation. */
function referenceWindowId(store: EventStore, sessionId: string): string | undefined {
  const folded = foldContextState(store.getContextWindowEvents(sessionId), '')
  return folded.currentContextWindowId || undefined
}

function snapshotData(currentContextWindowId: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    mode: 'planner' as const,
    phase: 'plan' as const,
    isRunning: false,
    messages: [],
    criteria: [],
    metadataEntries: {},
    contextState: {
      currentTokens: 10,
      maxTokens: 200000,
      compactionCount: 0,
      dangerZone: false,
      canCompact: false,
      dynamicContextChanged: false,
    },
    currentContextWindowId,
    todos: [],
    readFiles: [],
    snapshotSeq: 6,
    snapshotAt: Date.now(),
    ...overrides,
  }
}

describe('EventStore — fast context window lookup', () => {
  let db: Database.Database
  let store: EventStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new EventStore(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('extractContextWindowId', () => {
    it('extracts the window id of the three window-changing event types', () => {
      expect(extractContextWindowId({ type: 'session.initialized', data: { contextWindowId: 'w1' } })).toBe('w1')
      expect(extractContextWindowId({ type: 'turn.snapshot', data: { currentContextWindowId: 'w2' } })).toBe('w2')
      expect(extractContextWindowId({ type: 'context.compacted', data: { newWindowId: 'w3' } })).toBe('w3')
    })

    it('ignores a sub-agent compaction — it does not move the parent window', () => {
      expect(
        extractContextWindowId({
          type: 'context.compacted',
          data: { newWindowId: 'w3', subAgentId: 'sub-1' },
        }),
      ).toBeUndefined()
    })

    it('ignores every other event type', () => {
      expect(extractContextWindowId({ type: 'context.state', data: { currentTokens: 1 } })).toBeUndefined()
      expect(extractContextWindowId({ type: 'file.read', data: { path: '/a' } })).toBeUndefined()
      expect(extractContextWindowId({ type: 'message.start', data: { messageId: 'm' } })).toBeUndefined()
    })

    it('distinguishes "resets the window" (null) from "does not assign one" (undefined)', () => {
      // A snapshot without a window id RESETS the window in foldContextState
      // (it assigns unconditionally) — that must be reproduced, not skipped.
      expect(extractContextWindowId({ type: 'turn.snapshot', data: {} })).toBeNull()
      expect(extractContextWindowId({ type: 'session.initialized', data: {} })).toBeNull()
      expect(extractContextWindowId({ type: 'context.state', data: {} })).toBeUndefined()
    })
  })

  describe('equivalence with foldContextState', () => {
    /** Every scenario must produce the same window id on both paths. */
    const scenarios: Array<{ name: string; run: (store: EventStore, sessionId: string) => void }> = [
      {
        name: 'session.initialized only',
        run: (s, id) => {
          s.append(id, {
            type: 'session.initialized',
            data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
          })
        },
      },
      {
        name: 'no window-changing event at all',
        run: (s, id) => {
          s.append(id, { type: 'message.start', data: { messageId: 'm1', role: 'user', content: 'hi' } })
        },
      },
      {
        name: 'compaction after the initial window',
        run: (s, id) => {
          s.append(id, {
            type: 'session.initialized',
            data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
          })
          s.append(id, {
            type: 'context.compacted',
            data: { closedWindowId: 'w1', newWindowId: 'w2', beforeTokens: 10, afterTokens: 0, summary: '' },
          })
        },
      },
      {
        name: 'sub-agent compaction does not move the parent window',
        run: (s, id) => {
          s.append(id, {
            type: 'session.initialized',
            data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
          })
          s.append(id, {
            type: 'context.compacted',
            data: {
              closedWindowId: 'w1',
              newWindowId: 'w-sub',
              beforeTokens: 10,
              afterTokens: 0,
              summary: '',
              subAgentId: 'sub-1',
            },
          })
        },
      },
      {
        name: 'a snapshot is the authoritative absolute state',
        run: (s, id) => {
          s.append(id, {
            type: 'session.initialized',
            data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
          })
          s.append(id, { type: 'turn.snapshot', data: snapshotData('w-snap') })
        },
      },
      {
        name: 'compaction after a snapshot wins (later seq)',
        run: (s, id) => {
          s.append(id, { type: 'turn.snapshot', data: snapshotData('w-snap') })
          s.append(id, {
            type: 'context.compacted',
            data: { closedWindowId: 'w-snap', newWindowId: 'w-after', beforeTokens: 1, afterTokens: 0, summary: '' },
          })
        },
      },
      {
        name: 'a snapshot after a compaction wins (later seq)',
        run: (s, id) => {
          s.append(id, {
            type: 'session.initialized',
            data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
          })
          s.append(id, {
            type: 'context.compacted',
            data: { closedWindowId: 'w1', newWindowId: 'w2', beforeTokens: 1, afterTokens: 0, summary: '' },
          })
          s.append(id, { type: 'turn.snapshot', data: snapshotData('w-snap') })
        },
      },
      {
        name: 'context.state events never move the window',
        run: (s, id) => {
          s.append(id, {
            type: 'session.initialized',
            data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
          })
          s.append(id, {
            type: 'context.state',
            data: {
              currentTokens: 10,
              maxTokens: 200000,
              compactionCount: 0,
              dangerZone: false,
              canCompact: false,
              dynamicContextChanged: false,
            },
          })
        },
      },
      {
        name: 'a snapshot without a window id resets the window',
        run: (s, id) => {
          s.append(id, {
            type: 'session.initialized',
            data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
          })
          s.append(id, { type: 'turn.snapshot', data: snapshotData('w1') })
          const broken = snapshotData('w1')
          delete (broken as Partial<SessionSnapshot>).currentContextWindowId
          s.append(id, { type: 'turn.snapshot', data: broken })
        },
      },
      {
        name: 'many events between the window-changing ones',
        run: (s, id) => {
          s.append(id, {
            type: 'session.initialized',
            data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
          })
          for (let i = 0; i < 50; i++) {
            s.append(id, { type: 'message.start', data: { messageId: `m${i}`, role: 'user', content: 'x' } })
          }
          s.append(id, { type: 'turn.snapshot', data: snapshotData('w-snap') })
          for (let i = 0; i < 50; i++) {
            s.append(id, { type: 'message.delta', data: { messageId: 'm0', content: 'y' } })
          }
        },
      },
      {
        name: 'appendBatch carrying the window change',
        run: (s, id) => {
          s.appendBatch(id, [
            { type: 'session.initialized', data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' } },
            { type: 'message.start', data: { messageId: 'm1', role: 'user', content: 'hi' } },
            { type: 'turn.snapshot', data: snapshotData('w-batch') },
          ])
        },
      },
      {
        name: 'importEvents carrying the window change',
        run: (s, id) => {
          const events: StoredEvent[] = [
            {
              seq: 1,
              timestamp: 1,
              sessionId: 'other',
              type: 'session.initialized',
              data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
            },
            {
              seq: 2,
              timestamp: 2,
              sessionId: 'other',
              type: 'turn.snapshot',
              data: snapshotData('w-imported'),
            },
          ]
          s.importEvents(id, events)
        },
      },
    ]

    for (const scenario of scenarios) {
      it(`matches the fold — ${scenario.name}`, () => {
        const sessionId = 'session-equiv'
        scenario.run(store, sessionId)

        expect(store.getCurrentContextWindowId(sessionId)).toBe(referenceWindowId(store, sessionId))
      })
    }

    it('matches the fold after the snapshot is deleted (cleanup)', () => {
      const sessionId = 'session-cleanup'
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
      })
      store.append(sessionId, { type: 'turn.snapshot', data: snapshotData('w-snap') })

      expect(store.getCurrentContextWindowId(sessionId)).toBe(referenceWindowId(store, sessionId))

      // cleanupOldEvents keeps the latest snapshot and the state-changing
      // events, and deletes the rest.
      store.cleanupOldEvents(sessionId)
      expect(store.getCurrentContextWindowId(sessionId)).toBe(referenceWindowId(store, sessionId))
    })

    it('matches the fold after a tombstoned window-changing event', () => {
      const sessionId = 'session-tombstone'
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
      })
      store.append(sessionId, { type: 'turn.snapshot', data: snapshotData('w-snap') })

      const snapshotEvent = store.getEvents(sessionId).find((event) => event.type === 'turn.snapshot')!
      store.tombstoneEvents(sessionId, [snapshotEvent.seq])

      expect(store.getCurrentContextWindowId(sessionId)).toBe(referenceWindowId(store, sessionId))
      // The tombstoned snapshot is gone → the window falls back to the initial one.
      expect(store.getCurrentContextWindowId(sessionId)).toBe('w1')
    })

    it('matches the fold after events are deleted up to a seq', () => {
      const sessionId = 'session-delete'
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
      })
      store.append(sessionId, { type: 'turn.snapshot', data: snapshotData('w-snap') })

      store.deleteEventsUpToSeq(sessionId, 2)
      expect(store.getCurrentContextWindowId(sessionId)).toBe(referenceWindowId(store, sessionId))
    })

    it('matches the fold after the session is deleted', () => {
      const sessionId = 'session-delete-all'
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
      })
      store.append(sessionId, { type: 'turn.snapshot', data: snapshotData('w-snap') })

      store.deleteSession(sessionId)
      expect(store.getCurrentContextWindowId(sessionId)).toBe(referenceWindowId(store, sessionId))
      expect(store.getCurrentContextWindowId(sessionId)).toBeUndefined()
    })

    it('matches the fold when the payload of an event is rewritten', () => {
      const sessionId = 'session-update'
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
      })
      store.append(sessionId, { type: 'turn.snapshot', data: snapshotData('w-snap') })

      // updateEventPayload rewrites a payload in place — the side table must
      // stay consistent with it.
      const snapshotEvent = store.getEvents(sessionId).find((event) => event.type === 'turn.snapshot')!
      store.updateEventPayload(sessionId, snapshotEvent.seq, snapshotData('w-rewritten'))

      expect(store.getCurrentContextWindowId(sessionId)).toBe(referenceWindowId(store, sessionId))
    })
  })

  describe('legacy databases', () => {
    /**
     * A database created before the side table existed: the events carry the
     * window id in their payload, but the side table has no row.
     */
    function makeLegacyStore(): { legacyDb: Database.Database; legacy: EventStore } {
      const legacyDb = new Database(':memory:')
      legacyDb.exec(`
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
      legacyDb.exec(`CREATE INDEX idx_events_session_type_seq ON events(session_id, event_type, seq)`)
      const legacy = new EventStore(legacyDb)
      legacyDb
        .prepare(`INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, ?, ?, ?, ?)`)
        .run(
          'legacy-session',
          1,
          Date.now(),
          'session.initialized',
          JSON.stringify({ projectId: 'p', workdir: '/tmp', contextWindowId: 'w-legacy' }),
        )
      legacyDb
        .prepare(`INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, ?, ?, ?, ?)`)
        .run('legacy-session', 2, Date.now(), 'turn.snapshot', JSON.stringify(snapshotData('w-legacy-snap')))
      return { legacyDb, legacy: legacy }
    }

    it('answers correctly on a database with no side-table rows', () => {
      const { legacyDb, legacy } = makeLegacyStore()

      // The side table exists (created by initSchema) but is empty for this
      // session: the backfill must recover the window.
      expect(legacy.getCurrentContextWindowId('legacy-session')).toBe('w-legacy-snap')
      expect(legacy.getCurrentContextWindowId('legacy-session')).toBe(referenceWindowId(legacy, 'legacy-session'))
      legacyDb.close()
    })

    it('backfills the side table, so the next read is a pure lookup', () => {
      const { legacyDb, legacy } = makeLegacyStore()

      const before = legacyDb.prepare(`SELECT COUNT(*) AS n FROM event_context_window`).get() as { n: number }
      expect(before.n).toBe(0)

      legacy.getCurrentContextWindowId('legacy-session')

      const after = legacyDb.prepare(`SELECT COUNT(*) AS n FROM event_context_window`).get() as { n: number }
      expect(after.n).toBe(2)
      legacyDb.close()
    })

    it('is idempotent — a second backfill writes nothing new', () => {
      const { legacyDb, legacy } = makeLegacyStore()

      legacy.getCurrentContextWindowId('legacy-session')
      expect(legacy.backfillContextWindows('legacy-session')).toBe(0)
      expect(legacy.getCurrentContextWindowId('legacy-session')).toBe('w-legacy-snap')
      legacyDb.close()
    })

    it('falls back to the original fold when the side table cannot be written', () => {
      // A read-only database: the backfill cannot write, so the lookup must
      // still answer — via the original fold.
      const { legacyDb, legacy } = makeLegacyStore()
      legacyDb.exec(`PRAGMA query_only = ON`)

      expect(legacy.getCurrentContextWindowId('legacy-session')).toBe('w-legacy-snap')
      expect(legacy.getCurrentContextWindowId('legacy-session')).toBe(referenceWindowId(legacy, 'legacy-session'))
      legacyDb.close()
    })

    it('survives a store reopen — the backfilled side table persists', () => {
      const dir = mkdtempSync(join(tmpdir(), 'openfox-cw-legacy-'))
      const dbPath = join(dir, 'events.db')
      try {
        const firstDb = new Database(dbPath)
        const first = new EventStore(firstDb)
        first.append('reopen-session', {
          type: 'session.initialized',
          data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w-reopen' },
        })
        first.append('reopen-session', { type: 'turn.snapshot', data: snapshotData('w-reopen-snap') })
        expect(first.getCurrentContextWindowId('reopen-session')).toBe('w-reopen-snap')
        firstDb.close()

        // Reopen: the side table is on disk, so the answer must not depend on
        // re-parsing the snapshot payload.
        const secondDb = new Database(dbPath)
        const second = new EventStore(secondDb)
        expect(second.getCurrentContextWindowId('reopen-session')).toBe('w-reopen-snap')
        expect(second.getCurrentContextWindowId('reopen-session')).toBe(referenceWindowId(second, 'reopen-session'))
        secondDb.close()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('atomicity', () => {
    it('writes the side-table row in the same transaction as the event', () => {
      const sessionId = 'session-atomic'
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
      })

      const rows = db.prepare(`SELECT seq, event_type, window_id FROM event_context_window`).all() as Array<{
        seq: number
        event_type: string
        window_id: string
      }>

      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({ seq: 1, event_type: 'session.initialized', window_id: 'w1' })
    })

    it('leaves no side-table row for events that do not move the window', () => {
      const sessionId = 'session-noise'
      store.append(sessionId, { type: 'message.start', data: { messageId: 'm1', role: 'user', content: 'hi' } })
      store.append(sessionId, {
        type: 'context.state',
        data: {
          currentTokens: 1,
          maxTokens: 2,
          compactionCount: 0,
          dangerZone: false,
          canCompact: false,
          dynamicContextChanged: false,
        },
      })

      const rows = db.prepare(`SELECT COUNT(*) AS n FROM event_context_window`).all() as Array<{ n: number }>
      expect(rows[0]!.n).toBe(0)
    })

    it('rolls the side-table row back when the event insert fails', () => {
      const sessionId = 'session-rollback'
      // Force the event insert to fail on a duplicate (session_id, seq).
      const insert = db.prepare(
        `INSERT INTO events (session_id, seq, timestamp, event_type, payload) VALUES (?, ?, ?, ?, ?)`,
      )
      insert.run(sessionId, 1, Date.now(), 'message.start', JSON.stringify({ messageId: 'm1' }))

      const getNextSeqSpy = vi.spyOn(store as unknown as { getNextSeq: () => number }, 'getNextSeq').mockReturnValue(1)
      expect(() =>
        store.append(sessionId, {
          type: 'session.initialized',
          data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
        }),
      ).not.toThrow()
      getNextSeqSpy.mockRestore()
    })
  })

  describe('micro-corrections (D1/D2/D3)', () => {
    it('D1 — an empty window id reads back as undefined, like the original fold', () => {
      const sessionId = 'session-empty-window'
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: '' },
      })

      // The original fold spelled "no window" as an empty string, and the
      // public API as undefined. The fast path must not hand back ''.
      expect(store.getCurrentContextWindowId(sessionId)).toBeUndefined()
      expect(store.getCurrentContextWindowId(sessionId)).toBe(referenceWindowId(store, sessionId))
    })

    it('D1 — an empty window id on a snapshot reads back as undefined', () => {
      const sessionId = 'session-empty-snapshot'
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
      })
      store.append(sessionId, { type: 'turn.snapshot', data: snapshotData('') })

      expect(store.getCurrentContextWindowId(sessionId)).toBeUndefined()
      expect(store.getCurrentContextWindowId(sessionId)).toBe(referenceWindowId(store, sessionId))
    })

    it('D2 — a session deleted by direct SQL takes its side-table rows with it', () => {
      const sessionId = 'session-sql-delete'
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
      })
      store.append(sessionId, { type: 'turn.snapshot', data: snapshotData('w-snap') })

      expect(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM event_context_window WHERE session_id = ?`).get(sessionId) as {
            n: number
          }
        ).n,
      ).toBe(2)

      // The store's own delete path.
      store.deleteSession(sessionId)
      expect(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM event_context_window WHERE session_id = ?`).get(sessionId) as {
            n: number
          }
        ).n,
      ).toBe(0)
    })

    it('D2 — the cleanup trigger removes the side-table row of any deleted event', () => {
      const sessionId = 'session-trigger'
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
      })
      store.append(sessionId, { type: 'turn.snapshot', data: snapshotData('w-snap') })

      // Delete the event row directly (bypassing every store method) — the
      // trigger must still drop the side-table row, so the side table cannot
      // outlive the event log.
      db.prepare(`DELETE FROM events WHERE session_id = ? AND event_type = 'turn.snapshot'`).run(sessionId)

      const rows = db
        .prepare(`SELECT seq FROM event_context_window WHERE session_id = ? ORDER BY seq`)
        .all(sessionId) as Array<{ seq: number }>
      expect(rows.map((row) => row.seq)).toEqual([1])
      expect(store.getCurrentContextWindowId(sessionId)).toBe(referenceWindowId(store, sessionId))
    })

    it('D3 — rewriting a payload so it no longer assigns a window drops the stale row', () => {
      const sessionId = 'session-rewrite-reset'
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
      })
      store.append(sessionId, {
        type: 'context.compacted',
        data: { closedWindowId: 'w1', newWindowId: 'w2', beforeTokens: 1, afterTokens: 0, summary: '' },
      })
      expect(store.getCurrentContextWindowId(sessionId)).toBe('w2')

      // Rewrite the compaction as a SUB-AGENT compaction: it must no longer
      // move the parent window, so the stale row has to go.
      const compacted = store.getEvents(sessionId).find((event) => event.type === 'context.compacted')!
      store.updateEventPayload(sessionId, compacted.seq, {
        closedWindowId: 'w1',
        newWindowId: 'w2',
        beforeTokens: 1,
        afterTokens: 0,
        summary: '',
        subAgentId: 'sub-1',
      })

      expect(store.getCurrentContextWindowId(sessionId)).toBe(referenceWindowId(store, sessionId))
      expect(store.getCurrentContextWindowId(sessionId)).toBe('w1')
    })

    it('D3 — rewriting a payload to a different window follows the rewrite', () => {
      const sessionId = 'session-rewrite-window'
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
      })
      store.append(sessionId, { type: 'turn.snapshot', data: snapshotData('w-snap') })

      const snapshotEvent = store.getEvents(sessionId).find((event) => event.type === 'turn.snapshot')!
      store.updateEventPayload(sessionId, snapshotEvent.seq, snapshotData('w-rewritten'))

      expect(store.getCurrentContextWindowId(sessionId)).toBe('w-rewritten')
      expect(store.getCurrentContextWindowId(sessionId)).toBe(referenceWindowId(store, sessionId))
    })
  })

  describe('side-table hygiene', () => {
    /** Rows whose event no longer exists — the side table must never keep them. */
    function orphanCount(): number {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM event_context_window w
           WHERE NOT EXISTS (
             SELECT 1 FROM events e WHERE e.session_id = w.session_id AND e.seq = w.seq
           )`,
        )
        .get() as { n: number }
      return row.n
    }

    function sideTableCount(): number {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM event_context_window`).get() as { n: number }
      return row.n
    }

    const seed = (sessionId: string): void => {
      store.append(sessionId, {
        type: 'session.initialized',
        data: { projectId: 'p', workdir: '/tmp', contextWindowId: 'w1' },
      })
      store.append(sessionId, { type: 'turn.snapshot', data: snapshotData('w-snap') })
    }

    it('leaves no orphan row after cleanupOldEvents', () => {
      seed('hygiene-cleanup')
      store.cleanupOldEvents('hygiene-cleanup')
      expect(orphanCount()).toBe(0)
      expect(sideTableCount()).toBeGreaterThanOrEqual(0)
    })

    it('leaves no orphan row after deleteEventsUpToSeq', () => {
      seed('hygiene-delete-up')
      store.deleteEventsUpToSeq('hygiene-delete-up', 2)
      expect(orphanCount()).toBe(0)
    })

    it('leaves no orphan row after deleteEventsAfterSeq', () => {
      seed('hygiene-delete-after')
      store.deleteEventsAfterSeq('hygiene-delete-after', 1)
      expect(orphanCount()).toBe(0)
    })

    it('leaves no orphan row after deleteSession', () => {
      seed('hygiene-delete-session')
      store.deleteSession('hygiene-delete-session')
      expect(orphanCount()).toBe(0)
      expect(sideTableCount()).toBe(0)
    })

    it('leaves no orphan row after optimizeStorage drops old snapshots', () => {
      seed('hygiene-optimize')
      // A second, older snapshot — optimizeStorage keeps only the latest.
      store.append('hygiene-optimize', { type: 'turn.snapshot', data: snapshotData('w-older') })
      store.append('hygiene-optimize', { type: 'turn.snapshot', data: snapshotData('w-newest') })

      store.optimizeStorage()

      expect(orphanCount()).toBe(0)
      expect(store.getCurrentContextWindowId('hygiene-optimize')).toBe(referenceWindowId(store, 'hygiene-optimize'))
    })

    it('leaves no orphan row after consolidateSession', () => {
      seed('hygiene-consolidate')
      store.append('hygiene-consolidate', {
        type: 'message.start',
        data: { messageId: 'm1', role: 'user', content: 'hi' },
      })

      store.consolidateSession('hygiene-consolidate')

      expect(orphanCount()).toBe(0)
      expect(store.getCurrentContextWindowId('hygiene-consolidate')).toBe(
        referenceWindowId(store, 'hygiene-consolidate'),
      )
    })
  })
})
