/**
 * Code-audit surface plugin, node half. Beyond the loader seat, it owns the
 * skills-status HTTP route the Web panel polls: GET /codeaudit/skills reads
 * whether the official yak skill is installed (plus the last fetch error),
 * POST runs the fetch on demand (the browser cannot write the host fs).
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context merge (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  ensureYakSkill,
  isYakSkillInstalled,
  presetSkillsDir,
  yakSkillLastError,
} from 'dsh-codeaudit/codeaudit'

/** Cordis plugin name. */
export const name = 'ui-codeaudit'

/** Services required before the route can register. */
export const inject = ['webServer']

type SkillStatus = { yak: boolean; error?: string }

/** Answer one JSON payload. */
function reply(res: {
  writeHead(code: number, headers?: Record<string, string>): unknown
  end(body: string): unknown
}, code: number, payload: SkillStatus): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * Register the skills-status route on the GUI host's HTTP carrier.
 * @param ctx - host context carrying the webServer service.
 */
export function apply(ctx: Context): void {
  ctx.webServer.register({
    kind: 'exact',
    path: '/codeaudit/skills',
    handler: async (req, res) => {
      const status = async (): Promise<SkillStatus> => ({
        yak: await isYakSkillInstalled(presetSkillsDir()),
        ...(yakSkillLastError() === undefined ? {} : { error: yakSkillLastError() }),
      })
      try {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const current = await status()
          reply(res, 200, req.method === 'HEAD' ? { yak: current.yak } : current)
          return
        }
        if (req.method === 'POST') {
          await ensureYakSkill(presetSkillsDir())
          reply(res, 200, await status())
          return
        }
        res.writeHead(405, { allow: 'GET, HEAD, POST' })
        res.end()
      } catch (error) {
        const current = await status().catch(() => ({ yak: false }) as SkillStatus)
        reply(res, 200, { ...current, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
