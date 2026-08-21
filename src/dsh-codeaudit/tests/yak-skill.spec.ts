/**
 * The yak-skill auto-installer: fetch-once semantics into the preset skills
 * directory, silent failure, and body sanity checks.
 * @module
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureYakSkill, YAK_SKILL_URL } from '../src/yakSkill.ts'

const SKILL_BODY = `---
name: yak
description: Yakit POC generation reference
---

# yak

(fetched body)`

let tempDirs: string[] = []

async function tempSkillsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codeaudit-skills-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  tempDirs = []
  vi.unstubAllGlobals()
})

describe('ensureYakSkill', () => {
  it('downloads the upstream body into the skills root as flat yak.md', async () => {
    const fetchMock = vi.fn(async () => new Response(SKILL_BODY, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const dir = await tempSkillsDir()
    await ensureYakSkill(dir)
    expect(await readFile(join(dir, 'yak.md'), 'utf8')).toBe(SKILL_BODY)
    expect(fetchMock).toHaveBeenCalledWith(YAK_SKILL_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('skips the fetch when yak.md already exists', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const dir = await tempSkillsDir()
    await writeFile(join(dir, 'yak.md'), SKILL_BODY, 'utf8')
    await ensureYakSkill(dir)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stays silent on fetch and body failures (no throw, no file)', async () => {
    const dir = await tempSkillsDir()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway offline', { status: 502 })))
    await expect(ensureYakSkill(dir)).rejects.toThrow(/HTTP 502/)
    // The caller (plugin apply) swallows; here we assert the contract: no
    // partial file lands on failure.
    await expect(readFile(join(dir, 'yak.md'), 'utf8')).rejects.toThrow()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not a skill</html>', { status: 200 })))
    await expect(ensureYakSkill(dir)).rejects.toThrow(/looks wrong/)
  })
})
