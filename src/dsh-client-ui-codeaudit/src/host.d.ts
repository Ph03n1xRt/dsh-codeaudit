/**
 * Runtime shape of the core plugin module (`dsh-codeaudit/codeaudit`) as the
 * UI node half consumes it. The built artifact is plain JavaScript without
 * declarations; these signatures mirror src/dsh-codeaudit/src exports.
 */
declare module 'dsh-codeaudit/codeaudit' {
  /** Absolute path of the preset's shipped skills directory. */
  export function presetSkillsDir(): string
  /** Fetch the official yak skill when absent (curl fallback for proxies). */
  export function ensureYakSkill(skillsDir: string): Promise<void>
  /** Whether yak.md currently sits in the skills directory. */
  export function isYakSkillInstalled(skillsDir: string): Promise<boolean>
  /** The remembered last fetch failure, if any. */
  export function yakSkillLastError(): string | undefined
}
