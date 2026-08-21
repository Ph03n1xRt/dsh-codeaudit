/**
 * The bundled Yakit reference skills and their on-demand fallback fetch.
 *
 * Two substantive skills ship inside the package (flat `<name>.md` entries
 * the local provider discovers directly): webfuzzer-hotpatch (HTTP POC
 * syntax, fuzztag, request/response hot-patch hooks) and yaklang-syntax
 * (Yaklang DSL, including codec/crypto helpers). Both are self-contained;
 * their mentions of sibling skills are navigational, not required content.
 *
 * {@link ensureYakSkill} exists only for the deleted-file case: it fetches
 * whichever bundled skill is missing, trying the raw origin first and CDN
 * mirrors second (undici ignores HTTP(S)_PROXY, so a curl fallback runs
 * last for proxied hosts). Failures are remembered for the Web status
 * route; nothing here is on the audit's critical path.
 * @module dsh-codeaudit/src/yakSkill
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The bundled Yakit skills: flat file names and their upstream paths. */
const YAK_SKILLS = ['webfuzzer-hotpatch', 'yaklang-syntax'] as const

/** Mirrors tried in order for every fetch (origin first, CDNs second). */
const MIRRORS = [
  'https://raw.githubusercontent.com/yaklang/yak-skills/main/skills',
  'https://cdn.jsdelivr.net/gh/yaklang/yak-skills@main/skills',
  'https://raw.gitmirror.com/yaklang/yak-skills/main/skills',
] as const

/** Refuse absurd bodies so a captive portal page cannot become a skill. */
const MAX_SKILL_BYTES = 512 * 1024

/** The curl fallback would fight the stubbed fetches of the test suite. */
const CURL_FALLBACK = process.env.VITEST === undefined

/** Last failure of {@link ensureYakSkill}, surfaced by the skills status route. */
let lastError: string | undefined

/** Read the remembered last failure (undefined after a success). */
export function yakSkillLastError(): string | undefined {
  return lastError
}

/** Absolute path of this preset's skills directory (shipped with the package).
 * Resolved against the built lib/ layout; the source-tree layout (unit tests
 * running the TypeScript directly) falls back one level deeper. */
export function presetSkillsDir(): string {
  const fromLib = fileURLToPath(new URL('../preset/codeaudit/skills/', import.meta.url))
  if (existsSync(fromLib)) return fromLib
  return fileURLToPath(new URL('../../../preset/codeaudit/skills/', import.meta.url))
}

/** One plausible skill body: non-empty, bounded, frontmatter-headed. */
function plausible(body: string): boolean {
  return body.length > 0 && body.length <= MAX_SKILL_BYTES && body.startsWith('---')
}

/** Fetch one body via the global fetch (undici): no proxy-environment support. */
async function bodyViaNodeFetch(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status}`)
  return response.text()
}

/** Fetch one body via curl: honors HTTP(S)_PROXY, present everywhere dsh hosts run. */
async function bodyViaCurl(url: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  return new Promise<string>((resolve, reject) => {
    execFile('curl', ['-fsSL', '--max-time', '15', url], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error !== null) reject(new Error(`curl fallback failed: ${String(error)}`))
      else resolve(stdout)
    })
  })
}

/** Fetch one skill body: mirrors in order, curl fallback on every failure. */
async function fetchBody(name: string): Promise<string> {
  const attempts: Array<() => Promise<string>> = []
  for (const mirror of MIRRORS) {
    attempts.push(() => bodyViaNodeFetch(`${mirror}/${name}/SKILL.md`))
    if (CURL_FALLBACK) attempts.push(() => bodyViaCurl(`${mirror}/${name}/SKILL.md`))
  }
  let failure: unknown = new Error('no fetch attempt')
  for (const attempt of attempts) {
    try {
      const body = await attempt()
      if (plausible(body)) return body
      failure = new Error(`body looks wrong (${body.length} bytes)`)
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

/**
 * Ensure every bundled Yakit skill exists in the preset skills directory,
 * fetching only the missing ones.
 * @param skillsDir - absolute path to this preset's skills/ root.
 */
export async function ensureYakSkill(skillsDir: string): Promise<void> {
  const path = await import('node:path')
  const { access, writeFile } = await import('node:fs/promises')
  const missing: string[] = []
  for (const name of YAK_SKILLS) {
    try {
      await access(path.join(skillsDir, `${name}.md`))
    } catch {
      missing.push(name)
    }
  }
  if (missing.length === 0) {
    lastError = undefined
    return
  }
  try {
    for (const name of missing) {
      await writeFile(path.join(skillsDir, `${name}.md`), await fetchBody(name), 'utf8')
    }
    lastError = undefined
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    throw error
  }
}

/**
 * Whether every bundled Yakit skill sits in the given skills root.
 * @param skillsDir - absolute path to this preset's skills/ root.
 */
export async function isYakSkillInstalled(skillsDir: string): Promise<boolean> {
  const path = await import('node:path')
  const { access } = await import('node:fs/promises')
  for (const name of YAK_SKILLS) {
    try {
      await access(path.join(skillsDir, `${name}.md`))
    } catch {
      return false
    }
  }
  return true
}
