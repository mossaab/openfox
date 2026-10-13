import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Count real readFile calls on the fs/promises module while keeping behaviour.
const readCounts = { readFile: 0, stat: 0 }
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      readCounts.readFile++
      return actual.readFile(...args)
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      readCounts.stat++
      return actual.stat(...args)
    },
  }
})

import { loadConfig } from '../config.js'
import { closeDatabase, initDatabase } from '../db/index.js'
import { createProject } from '../db/projects.js'
import { getAllInstructions, clearInstructionCache } from './instructions.js'

describe('instruction file caching (disk I/O)', () => {
  let testDir: string
  beforeEach(async () => {
    closeDatabase()
    clearInstructionCache()
    const config = loadConfig()
    config.database.path = ':memory:'
    initDatabase(config)
    testDir = join(tmpdir(), `openfox-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(testDir, { recursive: true })
  })
  afterEach(async () => {
    closeDatabase()
    clearInstructionCache()
    await rm(testDir, { recursive: true, force: true })
  })

  it('reads an unchanged AGENTS.md from disk exactly once across N calls', async () => {
    const project = createProject('OpenFox', testDir)
    await writeFile(join(testDir, 'AGENTS.md'), '# Big instructions\n'.repeat(50))
    readCounts.readFile = 0
    readCounts.stat = 0

    for (let i = 0; i < 5; i++) await getAllInstructions(testDir, project.id)

    expect(readCounts.readFile).toBe(1)
  })
})
