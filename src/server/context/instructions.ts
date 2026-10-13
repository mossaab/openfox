import { readFile, access, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { constants } from 'node:fs'
import { getSetting, SETTINGS_KEYS } from '../db/settings.js'
import { getProject } from '../db/projects.js'
import type { InjectedFile } from '../../shared/types.js'

// ============================================================================
// Types
// ============================================================================

export interface InstructionFile {
  path: string
  source: 'agents-md' | 'global' | 'project'
  content?: string
}

export interface AllInstructions {
  content: string
  files: InstructionFile[]
}

export function buildLanguageInstruction(language: string | null | undefined): string | null {
  const trimmed = language?.trim()
  if (!trimmed || trimmed.toLowerCase() === 'automatic') return null
  const display = trimmed[0]!.toUpperCase() + trimmed.slice(1)
  return `## LANGUAGE\n\nAlways respond to the user in ${display}.`
}

// Filenames to look for (in order of priority within same directory)
const INSTRUCTION_FILENAMES = ['AGENTS.md', 'CLAUDE.md']

// ============================================================================
// File-content cache
// ============================================================================

/**
 * Cache of instruction-file contents, keyed by absolute path.
 *
 * `getAllInstructions()` runs on **every** iteration of the agent loop and for
 * every sub-agent. Without a cache the same AGENTS.md is read from disk (twice:
 * `loadInstructions` then the per-file `readFile` loop) on each call — for a
 * large instruction file on a long loop that is hundreds of MB of redundant I/O
 * and a needless stall before each LLM request. The cache invalidates on
 * (mtimeMs, size), so an edited file is picked up immediately while an
 * unchanged file is served from memory.
 */
interface CachedFile {
  mtimeMs: number
  size: number
  content: string
}

const fileContentCache = new Map<string, CachedFile>()

/** Read a file, returning a cached copy while its (mtimeMs, size) is unchanged. */
async function readCachedFile(path: string): Promise<string | undefined> {
  try {
    const stats = await stat(path)
    const cached = fileContentCache.get(path)
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.content
    }
    const content = await readFile(path, 'utf-8')
    fileContentCache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, content })
    return content
  } catch {
    // Unreadable / removed: drop any stale entry and report the miss.
    fileContentCache.delete(path)
    return undefined
  }
}

/** Drop the whole cache (tests / explicit invalidation). */
export function clearInstructionCache(): void {
  fileContentCache.clear()
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Find instruction files by walking up the directory tree from workdir.
 * Returns files ordered from root to workdir (parent directories first),
 * so that files closer to the working directory can override parent instructions.
 */
export async function findInstructionFiles(workdir: string): Promise<InstructionFile[]> {
  const foundFiles: InstructionFile[] = []
  const pathsToCheck: string[] = []

  // Walk up the directory tree
  let currentDir = workdir
  while (true) {
    pathsToCheck.unshift(currentDir) // Add to front (we want root-first order)

    const parentDir = dirname(currentDir)
    // Stop if we've reached the root (dirname returns same path)
    if (parentDir === currentDir) {
      break
    }
    currentDir = parentDir
  }

  // Check each directory for instruction files
  for (const dir of pathsToCheck) {
    for (const filename of INSTRUCTION_FILENAMES) {
      const filePath = join(dir, filename)
      if (await fileExists(filePath)) {
        foundFiles.push({
          path: filePath,
          source: 'agents-md',
        })
      }
    }
  }

  return foundFiles
}

/**
 * Load instruction content from files.
 * Each file's content is prefixed with a comment showing its source path.
 * Contents are served through the (mtimeMs, size)-invalidated cache, so an
 * unchanged file is never read from disk more than once.
 */
export async function loadInstructions(files: InstructionFile[]): Promise<string> {
  const contents: string[] = []

  for (const file of files) {
    const content = await readCachedFile(file.path)
    if (content === undefined) continue
    contents.push(`Instructions from: ${file.path}\n${content}`)
  }

  return contents.join('\n')
}

/**
 * Convenience function to find and load all instruction files for a workdir.
 * Only includes AGENTS.md files, not global or project instructions.
 */
export async function getInstructionsForWorkdir(workdir: string): Promise<{
  content: string
  files: InstructionFile[]
}> {
  const files = await findInstructionFiles(workdir)
  const content = await loadInstructions(files)
  return { content, files }
}

/**
 * Load ALL instructions from all sources for a session.
 * Order: language → global → project → AGENTS.md files
 * This is the primary function that should be used when building prompts.
 */
export async function getAllInstructions(workdir: string, projectId: string): Promise<AllInstructions> {
  const sections: string[] = []
  const allFiles: InstructionFile[] = []

  // 0. Language (from settings) - always first when set
  const languageInstruction = buildLanguageInstruction(getSetting(SETTINGS_KEYS.LANGUAGE))
  if (languageInstruction) {
    sections.push(languageInstruction)
  }

  // 1. Global instructions (from settings)
  const globalInstructions = getSetting(SETTINGS_KEYS.GLOBAL_INSTRUCTIONS)
  if (globalInstructions) {
    sections.push(`## GLOBAL INSTRUCTIONS\n\n${globalInstructions}`)
    allFiles.push({ path: 'Global Instructions', source: 'global', content: globalInstructions })
  }

  // 2. Project instructions (from project record)
  const project = getProject(projectId)
  if (project?.customInstructions) {
    sections.push(`## PROJECT INSTRUCTIONS\n\n${project.customInstructions}`)
    allFiles.push({ path: `Project: ${project.name}`, source: 'project', content: project.customInstructions })
  }

  // 3. AGENTS.md files (from filesystem)
  const agentFiles = await findInstructionFiles(workdir)
  if (agentFiles.length > 0) {
    const fileContents: { file: InstructionFile; content: string }[] = []
    for (const file of agentFiles) {
      // Single read per file (cached): the same content feeds both the
      // concatenated prompt section and the per-file entries below.
      const content = await readCachedFile(file.path)
      if (content !== undefined) fileContents.push({ file, content })
    }
    if (fileContents.length > 0) {
      const agentContent = fileContents
        .map(({ file, content }) => `Instructions from: ${file.path}\n${content}`)
        .join('\n')
      sections.push(`## FILE INSTRUCTIONS\n\n${agentContent}`)
      for (const { file, content } of fileContents) {
        allFiles.push({ ...file, content })
      }
    }
    // A file discovered but unreadable (removed between the walk and the read)
    // is still reported, without content — mirrors the previous behaviour.
    const unreadable = agentFiles.filter((f) => !fileContents.some((fc) => fc.file.path === f.path))
    for (const file of unreadable) {
      allFiles.push(file)
    }
  }

  return {
    content: sections.join('\n\n'),
    files: allFiles,
  }
}

// ============================================================================
// Helpers
// ============================================================================

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

export function toInjectedFiles(files: InstructionFile[]): InjectedFile[] {
  return files.map((file) => ({
    path: file.path,
    content: file.content ?? '',
    source: file.source,
  }))
}
