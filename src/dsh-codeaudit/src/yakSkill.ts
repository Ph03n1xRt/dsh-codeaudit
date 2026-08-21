/**
 * Best-effort auto-install of the official Yakit skill (yaklang/yak-skills)
 * into this preset's own skills directory. The yak skill documents Yakit POC
 * syntax and generation, which complements our poc/pocNote discipline.
 *
 * Runs once per package install: the marker file `yak.md` in the preset's
 * skills root is both the skill (the local provider accepts flat
 * `<name>.md` entries) and the "already installed" flag — delete it to
 * re-fetch a newer revision. Fetching tries the global fetch first and falls
 * back to curl, whose proxy-environment handling undici lacks (a proxied
 * host where `curl` works but Node fetch cannot reach the registry is the
 * common failure). Every failure is remembered for the Web status route and
 * retried on the next preset mount or button press.
 * @module dsh-codeaudit/src/yakSkill
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Upstream body of the official yak skill. */
export const YAK_SKILL_URL = 'https://raw.githubusercontent.com/yaklang/yak-skills/main/skills/yak/SKILL.md'

/** Absolute path of this preset's skills directory (shipped with the package).
 * Resolved against the built lib/ layout; the source-tree layout (unit tests
 * running the TypeScript directly) falls back one level deeper. */
export function presetSkillsDir(): string {
  const fromLib = fileURLToPath(new URL('../preset/codeaudit/skills/', import.meta.url))
  if (existsSync(fromLib)) return fromLib
  return fileURLToPath(new URL('../../../preset/codeaudit/skills/', import.meta.url))
}

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

/** One plausible skill body: non-empty, bounded, frontmatter-headed. */
function plausible(body: string): boolean {
  return body.length > 0 && body.length <= MAX_SKILL_BYTES && body.startsWith('---')
}

/** Fetch via the global fetch (undici): no proxy-environment support. */
async function bodyViaNodeFetch(): Promise<string> {
  const response = await fetch(YAK_SKILL_URL, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`yak skill fetch failed: HTTP ${response.status}`)
  return response.text()
}

/** Fetch via curl: honors HTTP(S)_PROXY, present everywhere dsh hosts run. */
async function bodyViaCurl(): Promise<string> {
  const { execFile } = await import('node:child_process')
  return new Promise<string>((resolve, reject) => {
    execFile('curl', ['-fsSL', '--max-time', '15', YAK_SKILL_URL], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error !== null) reject(new Error(`yak skill curl fallback failed: ${String(error)}`))
      else resolve(stdout)
    })
  })
}

/**
 * Ensure the yak skill exists in the given preset skills directory.
 * @param skillsDir - absolute path to this preset's skills/ root.
 */
export async function ensureYakSkill(skillsDir: string): Promise<void> {
  const path = await import('node:path')
  const { access, writeFile } = await import('node:fs/promises')
  const target = path.join(skillsDir, 'yak.md')
  try {
    await access(target)
    return // already installed
  } catch {
    // not installed yet — fetch below
  }
  const attempts: Array<() => Promise<string>> = CURL_FALLBACK
    ? [bodyViaNodeFetch, bodyViaCurl]
    : [bodyViaNodeFetch]
  let failure: unknown = new Error('no fetch attempt')
  for (const attempt of attempts) {
    try {
      const body = await attempt()
      if (!plausible(body)) throw new Error(`yak skill body looks wrong (${body.length} bytes)`)
      await writeFile(target, body, 'utf8')
      lastError = undefined
      return
    } catch (error) {
      failure = error
    }
  }
  lastError = failure instanceof Error ? failure.message : String(failure)
  throw failure
}

/**
 * Whether the yak skill is currently installed in the given skills root.
 * @param skillsDir - absolute path to this preset's skills/ root.
 */
export async function isYakSkillInstalled(skillsDir: string): Promise<boolean> {
  const path = await import('node:path')
  const { access } = await import('node:fs/promises')
  try {
    await access(path.join(skillsDir, 'yak.md'))
    return true
  } catch {
    return false
  }
}
