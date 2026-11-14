/**
 * Schema shared by the two places that bootstrap the `events` table:
 * `runMigrations()` (server startup) and `EventStore.initSchema()` (any store,
 * including tests and tools that open the database directly).
 *
 * The index set lives here so the two DDL copies cannot drift.
 */

/**
 * Indexes for `events`.
 *
 * The covering index serves the per-session, type-filtered reads: the snapshot
 * lookup (`event_type = 'turn.snapshot' ORDER BY seq DESC LIMIT 1`), the
 * context-window fold and the cleanup DELETE. Without `seq` in the index,
 * SQLite walks the whole session backwards and fetches each row — measured at
 * 105 ms per snapshot lookup on a 322k-event session, on every state load.
 *
 * The two dropping statements remove the superseded indexes on existing
 * databases: `(session_id, seq)` is already covered by the UNIQUE constraint's
 * auto-index, and `(session_id, event_type)` is a prefix of the covering index.
 * Both only cost a b-tree write per appended event — the hottest write path.
 */
export const EVENTS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_events_session_type_seq ON events(session_id, event_type, seq);
  DROP INDEX IF EXISTS idx_events_session_seq;
  DROP INDEX IF EXISTS idx_events_session_type;
`

/**
 * Side table: the context window id each window-changing event assigns.
 *
 * `foldContextState` derives the current context window from exactly three
 * event types (`session.initialized`, `turn.snapshot`, `context.compacted`),
 * but the only carrier of that state is the event payload — and a snapshot
 * payload is dominated by its `messages` array (tens of MB). Recovering the
 * window id therefore meant JSON-parsing the whole snapshot on every call
 * (measured: 360 ms on a 25 MB snapshot, on a path that runs inside every
 * tool execution and every LLM round).
 *
 * This table stores the assignment per event, so the hot path becomes an
 * index-only lookup. It is written in the same transaction as the event, and
 * rows are deleted together with their event — the `events` table stays the
 * single source of truth.
 */
export const EVENT_CONTEXT_WINDOW_DDL = `
  CREATE TABLE IF NOT EXISTS event_context_window (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    window_id TEXT,
    PRIMARY KEY (session_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_event_context_window_session_seq
    ON event_context_window(session_id, seq);
  CREATE TRIGGER IF NOT EXISTS trg_event_context_window_cleanup
  AFTER DELETE ON events
  FOR EACH ROW
  WHEN OLD.event_type IN ('session.initialized', 'turn.snapshot', 'context.compacted')
  BEGIN
    DELETE FROM event_context_window
    WHERE session_id = OLD.session_id AND seq = OLD.seq;
  END;
`
