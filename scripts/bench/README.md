# Benchmarks

Two independent harnesses live here:

- **Web memory** (below) — the browser-side memory footprint of a long,
  fast-streaming conversation.
- **Context-window lookup** — how long it takes to recover the current context
  window id of a session with a huge snapshot.

## Context-window lookup

```bash
npm run bench:context-window
```

Answers: "how long does it take to recover the current context window id?"

The window id is carried by the event payloads, but a `turn.snapshot` payload
is dominated by its `messages` array (tens of MB). The original path read the
window-changing events and JSON-parsed their payloads — 252 ms on a 20 MiB
snapshot, on a path that runs inside every tool execution and every LLM round.

The harness builds a **disposable** synthetic database in a temp directory
(deleted at the end) — no real database is ever opened — and measures three
paths on it:

| path                                        | what it measures              |
| ------------------------------------------- | ----------------------------- |
| `legacy — fold over parsed payloads`        | the original implementation   |
| `fast — side table lookup`                  | the current implementation    |
| `legacy — first access (backfill + lookup)` | a legacy database, first read |

The backfill is what a database created before the side table pays once: the
window-changing events are parsed, the side table is filled, and every later
read is a plain lookup.

### Knobs

| env                        | default | meaning                                  |
| -------------------------- | ------- | ---------------------------------------- |
| `BENCH_CW_MESSAGES`        | 1761    | messages in the synthetic snapshot       |
| `BENCH_CW_MESSAGE_CHARS`   | 12000   | characters per message                   |
| `BENCH_CW_ITERATIONS`      | 20      | samples per measurement (median is used) |
| `BENCH_CW_LEGACY_SESSIONS` | 3       | sessions seeded without a side-table row |

### Measured (2026-11-14, 20.3 MiB snapshot, 1761 messages)

| path                                        | median      |
| ------------------------------------------- | ----------- |
| `legacy — fold over parsed payloads`        | 252 ms      |
| `fast — side table lookup`                  | **0.15 ms** |
| `legacy — first access (backfill + lookup)` | 89 ms       |
| `fast — steady state after backfill`        | 0.14 ms     |

~1600x on the hot path, and the legacy first access is paid only once per
session.

### Write path

The side table must not tax the hottest write path. Ordinary events
(`message.delta` and friends) keep the historical shape of `append()` — a bare
`INSERT`, no explicit transaction; only the three window-changing event types
are wrapped in one, so their side-table row is written atomically with them.

| 10 000 ordinary appends        | per event          |
| ------------------------------ | ------------------ |
| current store                  | 343 µs             |
| historical shape (bare INSERT) | 359 µs             |
| **overhead**                   | **−4,5 %** (noise) |

Wrapping _every_ event in a transaction — the first implementation of the side
table — cost **+30,3 %** (447 µs/event vs 343 µs). The `WHEN` clause on the
cleanup trigger keeps the delete path free too.

---

# Web memory benchmark

Baseline harness for the browser-side memory footprint of a long, fast-streaming
conversation. It answers "how much RAM does the tab actually need, and does it
keep growing?" — the question behind "OpenFox becomes unusable after a while".

```bash
npm run bench:web                      # build the app, then measure
BENCH_SKIP_BUILD=1 npm run bench:web   # reuse an existing dist/ (~90s run)
```

The run is **report-only**: it never fails on a memory threshold. It fails only
if the app could not be driven at all (see `verifyRendered`).

## What it does

1. Boots the built app on a free port with an in-memory DB, mock LLM and a temp
   `HOME`/`XDG_*` (so your real config and database are never touched).
2. Creates a project + session over REST and opens it in headless Chromium.
3. Streams a synthetic conversation through the app's **real** WebSocket path
   (`page.routeWebSocket(...).connectToServer()` — real server frames are still
   forwarded), so the client's message handler, session store and React render
   do the actual work. No REST stubbing of the session.
4. Every `targetTokens / 10` tokens of growth: forces GC via CDP
   (`HeapProfiler.collectGarbage`), then samples the renderer's heap
   (`Performance.getMetrics`) and DOM counters (`Memory.getDOMCounters`).
5. After a settle period, samples what the app _retains_ — the leak signal.
6. Writes `scripts/bench/baseline.json` and prints a table.

## Frame timing

The page runs a `requestAnimationFrame` sampler for the whole run, so every
painted frame is timestamped. Gaps between timestamps are the jank signal: a
blocked main thread delays callbacks rather than skipping them.

An **idle control sample** is taken first, because headless Chrome drives frames
off its own BeginFrame source — without it, a synthetic cadence cap would read
as app slowness. On this machine idle is a clean 60 fps, which makes the
streaming numbers comparable.

`fps` is per checkpoint window (the streaming since the previous checkpoint),
`worst` is the longest single frame in that window, and `jank` counts frames
over 50 ms. The forced GC at each checkpoint is excluded from every window, so
it never shows up as a stall. The `cold load` row is the at-rest cadence.

Caveat: the harness injects frames as fast as it can (`BENCH_BATCH_SIZE` per
animation frame), so streaming fps measures **how fast the app absorbs a burst**,
not a real user's frame rate. It is a comparative number — use it to prove a fix,
not as an absolute.

## Workload shape

40 turns, sized so the conversation reaches `BENCH_TARGET_TOKENS` (default
200K). Each turn: user message → assistant placeholder → streamed thinking →
streamed text deltas → 6 tool calls (args streamed, output streamed, then the
result) → turn completion → context state. Tokens use the app's own accounting
(`chars / 4`).

## Reading the report

| column       | meaning                                                                               |
| ------------ | ------------------------------------------------------------------------------------- |
| `js heap`    | renderer JS heap after a forced GC — the real memory number                           |
| `dom nodes`  | CDP node counter, includes detached-but-retained node objects                         |
| `dom els`    | elements actually mounted in the document — the render cost                           |
| `items`      | top-level mounted feed items (`data-item-index`), capped by `display.maxVisibleItems` |
| `listeners`  | live JS event listeners                                                               |
| `chrome rss` | RSS of every Chrome process (browser + renderers + GPU)                               |
| `fps`        | animation frames per second over the window ending at this checkpoint                 |
| `worst`      | longest single frame in that window, in ms                                            |
| `jank`       | frames longer than 50 ms in that window                                               |

`dom nodes` runs far above `dom els` when streamed DOM is retained after being
replaced — that gap is a leak signal, not a rendering cost.

`leak slope` is the least-squares growth in heap per 10K tokens of conversation.
A healthy feed plateaus once the display window caps it; a slope that stays
positive means memory scales with the conversation rather than the window.

## Comparing runs

Every run writes a JSON report. Point a run at an earlier one and it prints a
delta table with a verdict per metric (changes under 3% count as noise):

```bash
BENCH_SKIP_BUILD=1 BENCH_OUTPUT=/tmp/today.json \
  BENCH_COMPARE=scripts/bench/baseline.json \
  npm run bench:web
```

`BENCH_PERF_SETTINGS` applies the display settings the UI groups under
"Performance" before opening the page. Pass `1` or `all` for every setting, or a
comma-separated list of aliases — `native-scrollbars`, `native-scrollbars-code`,
`collapse-large-tools`, `defer-highlight`, `virtualization`. Prefix an alias with
`no-` to write it _off_, which is how you ablate a setting that is on by default.
An unknown alias throws rather than silently measuring nothing.

```bash
BENCH_PERF_SETTINGS=no-virtualization BENCH_SKIP_BUILD=1 npm run bench:web
```

`BENCH_MAX_VISIBLE_ITEMS` overrides `display.maxVisibleItems` (app default 100).
Applied settings are recorded in the report.

## Measured state (2026-09-21, AMD Ryzen AI 9 HX 370, headless Chromium)

`baseline.json`, app defaults with nothing applied — what a fresh install gets,
because feed virtualization is now on by default:

| items | placeholders | scrollbars | dom els | chrome rss | retained heap | leak slope | fps  | worst | jank |
| ----- | ------------ | ---------- | ------- | ---------- | ------------- | ---------- | ---- | ----- | ---- |
| 30    | 50           | 20         | 27,384  | 1099 MB    | 56.7 MB       | 1.33       | 20.4 | 833   | 148  |

For contrast, `BENCH_PERF_SETTINGS=no-virtualization` — the behaviour before the
default changed:

| variant                     | items | dom els | chrome rss | retained heap | fps  | duration |
| --------------------------- | ----- | ------- | ---------- | ------------- | ---- | -------- |
| virtualization off          | 80    | 72,712  | 1755 MB    | 89.3 MB       | 7.0  | 86.5 s   |
| virtualization on (default) | 30    | 27,384  | 1099 MB    | 56.7 MB       | 20.4 | 30.8 s   |

The DOM **plateaus** in the default config: 30 mounted items with 50
placeholders, flat from the moment the window fills. Per-item cost is unchanged
(~900 elements per item) — the window mounts fewer items, it does not make them
cheaper.

## Settings: what each one is worth

The five display settings under "Performance" were ablated individually, in
cumulative subsets, and leave-one-out. Conclusion:

- **Feed virtualization carries essentially the whole win** (fps 7.0 → 20.4,
  elements −62%, RSS −37%).
- **`native-scrollbars` is now redundant.** It used to be worth ~8.8 fps by
  avoiding 325 OverlayScrollbars instances — each with a `MutationObserver` over
  its host subtree plus two `ResizeObserver`s. Once `OptionalScrollArea` stopped
  creating instances for panes that cannot scroll (325 → 45), it has nothing left
  to remove.
- `native-scrollbars-code`, `collapse-large-tools` and `defer-highlight` are
  inside noise.

So virtualization and the 100-item window are defaults, and the other four stay
off — which keeps the unified overlay scrollbar styling everywhere.

The residual ~40 instances are `RunCommandView` panes, which need a live scroll
container for programmatic auto-scroll and are not controlled by that setting.

Caveat: absolute numbers drift with machine load (this box had ~7 GB RAM
available and 2 GB swapped). Compare only within a batch.

## Knobs

| env                       | default         | meaning                                          |
| ------------------------- | --------------- | ------------------------------------------------ |
| `BENCH_TARGET_TOKENS`     | 200000          | conversation size to reach (min 20000)           |
| `BENCH_BATCH_SIZE`        | 120             | frames injected per animation frame              |
| `BENCH_SETTLE_MS`         | 3000            | settle before the retained-heap sample           |
| `BENCH_PERF_SETTINGS`     | –               | `all`, `1`, or a comma-separated list of aliases |
| `BENCH_MAX_VISIBLE_ITEMS` | 100 (app)       | feed window size override                        |
| `BENCH_OUTPUT`            | `baseline.json` | where to write the report                        |
| `BENCH_COMPARE`           | –               | earlier report to diff against                   |
| `BENCH_SKIP_BUILD`        | –               | `1` to reuse `dist/`                             |
| `BENCH_KEEP_ARTIFACTS`    | –               | `1` to keep the temp project/config dirs         |

`items` counts mounted top-level feed items; `placeholders` counts the unmounted
slots the virtual window leaves behind. `placeholders > 0` is the only reliable
signal that feed virtualization actually engaged.

`overlay scrollbars` counts live OverlayScrollbars instances
(`[data-overlayscrollbars-viewport]`). Each one installs a `MutationObserver`
over its host subtree plus two `ResizeObserver`s. The count tracks rendered tool
call panes — ~1.35 per pane — so it is the cheapest single indicator of how much
scroll machinery the feed is carrying: 325 with 80 items mounted and eager
panes, 45 with the lazy `OptionalScrollArea` fallback, 20 in the default
(virtualized) config.

Repeatability on a quiet machine: retained heap within ~1%, DOM elements
identical, Chrome RSS within ~5%, streaming fps within ~0.3. Absolute values
drift with machine load — compare within a batch, not across days.
