import { describe, it, expect } from 'vitest'
import { parseArgs, durationMin, summarize, projectDuration, type RunReport } from './measure-workflow-runs.js'

function report(overrides: Partial<RunReport>): RunReport {
  return {
    sessionId: 's',
    workflowId: 'default',
    workflowName: 'Build & Verify',
    status: 'completed',
    durationMin: 0,
    llmRounds: 0,
    toolCalls: 0,
    criteria: 0,
    cachedPromptChars: 0,
    maxTurnsHit: false,
    ...overrides,
  }
}

describe('measure-workflow-runs', () => {
  describe('parseArgs', () => {
    it('defaults to non-json with a limit', () => {
      expect(parseArgs([])).toEqual({ json: false, limit: 25 })
    })

    it('parses workflow / min-criteria / json / limit', () => {
      expect(parseArgs(['--workflow', 'default', '--min-criteria', '20', '--json', '--limit', '5'])).toEqual({
        workflow: 'default',
        minCriteria: 20,
        json: true,
        limit: 5,
      })
    })
  })

  describe('durationMin', () => {
    it('converts ms to minutes rounded to 0.1', () => {
      expect(durationMin({ created_at: 0, updated_at: 90_000 })).toBe(1.5)
    })

    it('returns 0 when a timestamp is missing', () => {
      expect(durationMin({ created_at: 0, updated_at: 0 })).toBe(0)
    })
  })

  describe('summarize', () => {
    it('ignores runs with no criteria', () => {
      const s = summarize([
        report({ durationMin: 200, criteria: 0 }),
        report({ durationMin: 30, criteria: 6 }),
        report({ durationMin: 90, criteria: 9 }),
      ])
      expect(s).toEqual({ count: 2, medianMin: 90, maxMin: 90, under60: 1 })
    })

    it('returns zeros when no run carries criteria', () => {
      expect(summarize([report({ criteria: 0 })])).toEqual({ count: 0, medianMin: 0, maxMin: 0, under60: 0 })
    })
  })

  describe('projectDuration', () => {
    it('scales a run that exceeded the cap by cap/rounds', () => {
      // 4000 rounds over 400 min → capped at 100 rounds → ~10 min
      const d = projectDuration(report({ durationMin: 400, llmRounds: 4000 }), 100)
      expect(d).toBeCloseTo(10, 1)
    })

    it('leaves a run under the cap unchanged', () => {
      expect(projectDuration(report({ durationMin: 20, llmRounds: 50 }), 100)).toBe(20)
    })

    it('applies the prompt ratio on top of the cap', () => {
      const d = projectDuration(report({ durationMin: 400, llmRounds: 4000 }), 100, 0.5)
      expect(d).toBeCloseTo(5, 1)
    })

    it('treats cap 0 as disabled (only the prompt ratio applies)', () => {
      expect(projectDuration(report({ durationMin: 100, llmRounds: 5000 }), 0, 0.2)).toBeCloseTo(20, 1)
    })
  })
})
