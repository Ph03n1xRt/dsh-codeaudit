/**
 * Code-audit mode for the DeepSeek Harness.
 *
 * A single plugin package that wires the durable `codeaudit` storage domain,
 * the nine model-facing `codeaudit_*` tools (audit graph + code assets with
 * evidence chains and frozen code snippets), and the decision-agent protocol
 * prompt section. Compose it in a profile overlay together with a decision
 * agent persona, subagent delegation tools, goal continuation, ask-user, and
 * the storage hub (`dsh-storage`), backend (`dsh-storage-sqlite`), and domain
 * facility. Subagents return their structured output to the decision agent,
 * which owns every `codeaudit_*` record.
 * @module dsh-codeaudit
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { CODEAUDIT_INSTRUCTIONS, CODEAUDIT_SECTION_ORDER } from './instructions.ts'
import {
  applyCodeauditEvent,
  codeauditInitialState,
  codeauditProjectionSchema,
  viewCodeauditState,
} from './projection.ts'
import { CodeauditStore } from './store.ts'
import { registerCodeauditTools } from './tools.ts'

export type { CodeauditStateView } from './store.ts'
export {
  codeauditDomainSpec,
  codeauditAssetSchema,
  codeauditAssetTypeSchema,
  codeauditEdgeKindSchema,
  codeauditEdgeSchema,
  codeauditEngagementSchema,
  codeauditEvidenceKindSchema,
  codeauditEvidenceSchema,
  codeauditFindingSchema,
  codeauditFindingStatusSchema,
  codeauditIntentSchema,
  codeauditSeveritySchema,
  SNIPPET_MAX_CHARS,
  capSnippet,
} from './spec.ts'
export type {
  CodeauditAsset,
  CodeauditAssetType,
  CodeauditEdge,
  CodeauditEdgeKind,
  CodeauditEngagement,
  CodeauditEvidence,
  CodeauditEvidenceKind,
  CodeauditFinding,
  CodeauditFindingStatus,
  CodeauditIntent,
  CodeauditSeverity,
} from './spec.ts'

/** Plugin identity. */
export const name = 'codeaudit'
/** Services required before the plugin can register tools and open the domain. */
export const inject = ['tools', 'storageDomain', 'sessions']

/**
 * Activate the code-audit mode on a context carrying the tool registry and the
 * storage-domain facility. The domain is opened lazily on first tool use and
 * closed when the plugin fiber is disposed.
 * @param ctx - registrant context.
 */
export function apply(ctx: Context): void {
  const store = new CodeauditStore(ctx)
  ctx.effect(() => async () => {
    await store.dispose()
  }, 'codeaudit.domainClose')
  registerCodeauditTools(ctx, store)
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    // The unit child activates only when a projection registry is composed
    // (headless assemblies without the seam stay unaffected). Standing fold:
    // the audit graph rebuilt from the logged codeaudit_* tool calls; null
    // before the first codeaudit_set_engagement of the session.
    projectionCtx.sessionProjections.register({
      key: 'codeaudit',
      schema: codeauditProjectionSchema,
      init: () => codeauditInitialState,
      apply: applyCodeauditEvent,
      view: viewCodeauditState,
      stateVersion: 1,
    })
  })
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: 'codeaudit:protocol',
      order: CODEAUDIT_SECTION_ORDER,
      text: () => CODEAUDIT_INSTRUCTIONS,
    })
  })
}
