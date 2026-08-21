/**
 * Best-effort auto-install of the official Yakit skill (yaklang/yak-skills)
 * into this preset's own skills directory. The yak skill documents Yakit POC
 * syntax and generation, which complements our poc/pocNote discipline.
 *
 * Runs once per package install: the marker file `yak.md` in the preset's
 * skills root is both the skill (the local provider accepts flat
 * `<name>.md` entries) and the "already installed" flag — delete it to
 * re-fetch a newer revision. Every failure is swallowed (offline host,
 * read-only install, changed upstream shape): the audit works without the
 * skill, and the next preset mount retries.
 * @module dsh-codeaudit/src/yakSkill
 */

/** Upstream body of the official yak skill. */
export const YAK_SKILL_URL = 'https://raw.githubusercontent.com/yaklang/yak-skills/main/skills/yak/SKILL.md'

/** Refuse absurd bodies so a captive portal page cannot become a skill. */
const MAX_SKILL_BYTES = 512 * 1024

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
  const response = await fetch(YAK_SKILL_URL, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`yak skill fetch failed: HTTP ${response.status}`)
  const body = await response.text()
  if (body.length === 0 || body.length > MAX_SKILL_BYTES || !body.startsWith('---')) {
    throw new Error(`yak skill body looks wrong (${body.length} bytes)`)
  }
  await writeFile(target, body, 'utf8')
}
