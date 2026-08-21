/**
 * Refresh the bundled official yak skill (preset/codeaudit/skills/yak.md)
 * from yaklang/yak-skills. Tries the raw origin first, then CDN mirrors —
 * commit the refreshed file so the shipped tarball never needs a network.
 */
import { writeFile } from 'node:fs/promises'

const TARGET = 'preset/codeaudit/skills/yak.md'
const SOURCES = [
  'https://raw.githubusercontent.com/yaklang/yak-skills/main/skills/yak/SKILL.md',
  'https://cdn.jsdelivr.net/gh/yaklang/yak-skills@main/skills/yak/SKILL.md',
  'https://raw.gitmirror.com/yaklang/yak-skills/main/skills/yak/SKILL.md',
]

for (const url of SOURCES) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.text()
    if (!body.startsWith('---') || body.length > 512 * 1024) throw new Error('body looks wrong')
    await writeFile(TARGET, body, 'utf8')
    console.log(`refreshed ${TARGET} from ${url} (${body.length} bytes)`)
    process.exit(0)
  } catch (error) {
    console.warn(`source failed (${url}): ${error.message}`)
  }
}
console.error('all sources failed; keeping the existing file')
process.exit(1)
