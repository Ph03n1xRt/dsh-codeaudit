/**
 * Bundle-owned read-only preset root. DSH rc.6 replaces configured preset
 * roots with its bundled root while it boots a profile; this row adds the
 * package's own preset directory back after the `agentPresets` service
 * exists, so an installed bundle exposes its preset without copying files
 * into the user's DSH home.
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/** Services required before the root can be registered. */
export const inject = ['agentPresets']

/**
 * Register the package-owned preset root (idempotent).
 * @param ctx - registrant context.
 */
export function apply(ctx: Context): void {
  const root = fileURLToPath(new URL('../preset/', import.meta.url))
  const presets = ctx.get('agentPresets')
  if (!presets.resolvedRoots.some((entry: { path: string }) => entry.path === root)) {
    presets.resolvedRoots.unshift({ path: root, trust: 'system' })
  }
}
