/**
 * Refresh the bundled official yak skill (preset/codeaudit/skills/yak.md)
 * from yaklang/yak-skills. Tries the raw origin first, then CDN mirrors —
 * commit the refreshed file so the shipped tarball never needs a network.
 */
import { writeFile } from 'node:fs/promises'

const SKILLS = ['webfuzzer-hotpatch', 'yaklang-syntax']
const MIRRORS = [
  'https://raw.githubusercontent.com/yaklang/yak-skills/main/skills',
  'https://cdn.jsdelivr.net/gh/yaklang/yak-skills@main/skills',
  'https://raw.gitmirror.com/yaklang/yak-skills/main/skills',
]

let failed = false
for (const name of SKILLS) {
  const target = `preset/codeaudit/skills/${name}.md`
  let done = false
  for (const mirror of MIRRORS) {
    if (done) break
    const url = `${mirror}/${name}/SKILL.md`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.text()
      if (!body.startsWith('---') || body.length > 512 * 1024) throw new Error('body looks wrong')
      await writeFile(target, body, 'utf8')
      console.log(`refreshed ${target} from ${url} (${body.length} bytes)`)
      done = true
    } catch (error) {
      console.warn(`source failed (${url}): ${error.message}`)
    }
  }
  if (!done) {
    console.error(`all sources failed for ${name}; keeping the existing file`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
