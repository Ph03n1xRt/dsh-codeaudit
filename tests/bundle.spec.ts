/**
 * The dsh-codeaudit bundle package: the patch layer parses and names the rows
 * it composes, the inert node half mounts, the preset files exist with the
 * expected ids, and the runtime import contract is declared.
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { apply as nodeApply } from '../lib/index.js'

const PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url))

/** The loader's `!!js` scalar: parse as its raw expression string. */
const jsExprTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: unknown) => data,
})
const patchSchema = yaml.JSON_SCHEMA.extend(jsExprTag)

describe('dsh-codeaudit bundle', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('the patch layer declares the UI and storage rows, and the route override', () => {
    const patch = yaml.load(readFileSync(PATCH_PATH, 'utf8'), { schema: patchSchema }) as Array<Record<string, unknown>>
    const insert = patch.find(entry => entry.insert !== undefined)
    expect(insert).toBeDefined()
    const rows = (insert!['insert'] as Array<{ id: string; name: string }>).map(row => ({ id: row.id, name: row.name }))
    // The UI row resolves to a subpath of this self-contained bundle package;
    // the sqlite backend is the official dsh package, installed as a dependency.
    expect(rows).toEqual([
      { id: 'ui-codeaudit', name: 'dsh-codeaudit/ui-codeaudit' },
      { id: 'storage-sqlite', name: '@deepseek-ai/dsh-storage-sqlite' },
    ])
    const insertedRows = insert!['insert'] as Array<{ id: string; name?: string; config?: { path?: string } }>
    const sqlite = insertedRows.find(row => row.id === 'storage-sqlite')!
    expect(sqlite.config).toEqual({ path: "dshHomePath('storages', 'codeaudit-sessions.db')" })
    const override = patch.find(entry => entry.id === 'storage-domain') as { config: { backend: string; routes: Record<string, string> } }
    expect(override.config).toMatchObject({ backend: 'json', routes: { codeaudit: 'sqlite' } })
    const presetRoot = patch.find(entry => {
      const inserted = entry.insert as Array<{ id: string; name: string }> | undefined
      return inserted?.some(row => row.id === 'codeaudit-preset-root')
    })
    expect(presetRoot).toBeDefined()
    expect((presetRoot!.insert as Array<{ id: string; name: string }>)).toEqual([
      { id: 'codeaudit-preset-root', name: 'dsh-codeaudit/preset-root' },
    ])
  })

  it('ships the codeaudit agent preset with the core plugin row and submit-only subagents', () => {
    const presetDir = fileURLToPath(new URL('../preset/codeaudit/', import.meta.url))
    expect(existsSync(`${presetDir}preset.yml`)).toBe(true)
    const meta = yaml.load(readFileSync(`${presetDir}preset.yml`, 'utf8')) as { name: string; description: string }
    expect(meta.name).toBe('代码审计模式')
    const composition = yaml.load(readFileSync(`${presetDir}agent.cordis.yml`, 'utf8'), { schema: patchSchema }) as Array<Record<string, unknown>>
    const codeaudit = composition.find(row => row.id === 'codeaudit') as { name?: string }
    expect(codeaudit?.name).toBe('dsh-codeaudit/codeaudit')
    // The core plugin row appears exactly once (never again in the patch file).
    const patchText = readFileSync(PATCH_PATH, 'utf8')
    expect(patchText).not.toContain('dsh-codeaudit/codeaudit\n')
    // Both subagent rows deny every write/read tool except codeaudit_submit.
    // The preset ships its own skills/ directory and mounts it through its
    // skill-filesystem row (customSkillDirs), landing in this preset's layer.
    const skillRow = composition.find(row => row.id === 'skill-filesystem') as { config?: { customSkillDirs?: string[] } }
    expect(skillRow?.config?.customSkillDirs?.[0]).toContain("new URL('skills/', baseUrl)")
    expect(existsSync(`${presetDir}skills/codeaudit-methodology/SKILL.md`)).toBe(true)
    // The official yak skill ships in the box: no runtime network needed.
    expect(existsSync(`${presetDir}skills/yak.md`)).toBe(true)
    const delegation = composition.find(row => row.id === 'delegation') as { config?: Array<{ id?: string; config?: { toolFilter?: { deny?: string[] } } }> }
    const subagents = delegation.config?.filter(row => row.id === 'tool-subagent' || row.id === 'tool-subagent-fork') ?? []
    expect(subagents).toHaveLength(2)
    for (const row of subagents) {
      expect(row.config?.toolFilter?.deny).toEqual(expect.arrayContaining([
        'codeaudit_set_engagement', 'codeaudit_add_intent', 'codeaudit_add_evidence', 'codeaudit_add_finding',
        'codeaudit_add_asset', 'codeaudit_state', 'codeaudit_graph', 'codeaudit_report', 'subagent', 'subagent_fork',
      ]))
    }
  })

  it('declares the runtime import contract', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      dsh?: { client?: { inject?: string[]; platform?: string }; bundle?: { patch?: string } }
    }
    expect(manifest.dependencies?.['@deepseek-ai/dsh-storage-sqlite']).toBe('0.1.0-rc.6')
    expect(manifest.dependencies?.['zod']).toBeDefined()
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-storage']).toBe('0.1.0-rc.6')
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-storage-domain']).toBe('0.1.0-rc.6')
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-tools']).toBe('0.1.0-rc.6')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.client?.inject).toEqual([
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
    ])
  })
})
