/**
 * The yak-skill fallback installer: fetch-once semantics for the bundled
 * pair (webfuzzer-hotpatch, yaklang-syntax), silent failure, body sanity.
 * @module
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureYakSkill, isYakSkillInstalled } from '../src/yakSkill.ts'

const SKILL_BODY = `---
name: placeholder
description: fetched body
---

(fetched body)`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ensureYakSkill', () => {
  it('downloads every missing bundled skill into the skills root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeaudit-skills-'))
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(String(url))
      return new Response(SKILL_BODY, { status: 200 })
    }))
    await ensureYakSkill(dir)
    expect(await readFile(join(dir, 'webfuzzer-hotpatch.md'), 'utf8')).toBe(SKILL_BODY)
    expect(await readFile(join(dir, 'yaklang-syntax.md'), 'utf8')).toBe(SKILL_BODY)
    // Both skills fetched from a mirror path under yaklang/yak-skills.
    expect(seen.filter(url => url.includes('webfuzzer-hotpatch/SKILL.md'))).toHaveLength(1)
    expect(seen.filter(url => url.includes('yaklang-syntax/SKILL.md'))).toHaveLength(1)
    expect(await isYakSkillInstalled(dir)).toBe(true)
  })

  it('skips the network when both files already exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeaudit-skills-'))
    await writeFile(join(dir, 'webfuzzer-hotpatch.md'), SKILL_BODY, 'utf8')
    await writeFile(join(dir, 'yaklang-syntax.md'), SKILL_BODY, 'utf8')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await ensureYakSkill(dir)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await isYakSkillInstalled(dir)).toBe(true)
  })

  it('stays silent-failing with no partial install on a hard failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeaudit-skills-'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway offline', { status: 502 })))
    await expect(ensureYakSkill(dir)).rejects.toThrow(/HTTP 502/)
    await expect(readFile(join(dir, 'webfuzzer-hotpatch.md'), 'utf8')).rejects.toThrow()
    expect(await isYakSkillInstalled(dir)).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not a skill</html>', { status: 200 })))
    await expect(ensureYakSkill(dir)).rejects.toThrow(/looks wrong/)
  })
})
