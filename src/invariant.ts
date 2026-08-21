/**
 * Package-owned invariant companion for `dsh-codeaudit`: the merged single
 * package carries the codeaudit host plugin, so this companion checks the
 * audit discipline — every codeaudit write honors the referential rules
 * (records carry the session id of an existing engagement row, every edge
 * references source/target nodes of the exact kinds its kind demands, and
 * every finding's evidence chain resolves, all within one session). The store
 * enforces the same rules at its write boundary, so a violation here means a
 * write path bypassed the store or landed a torn record.
 * @module dsh-codeaudit/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { CodeauditEdgeKind } from './dsh-codeaudit/src/spec.ts'
import type {} from '@deepseek-ai/dsh-storage'

const PACKAGE_NAME = 'dsh-codeaudit'
const DOMAIN_NAME = 'codeaudit'

function recordKey(sessionId: string, id: string): string {
  return `${sessionId}:${id}`
}

/** Tables whose records must reference an existing engagement row of the session. */
const ENGAGEMENT_OWNED_TABLES = ['intents', 'evidences', 'findings', 'assets', 'edges'] as const

/** The source table an edge kind anchors on (validated for the same session). */
const SOURCE_TABLE_OF_EDGE: Record<CodeauditEdgeKind, 'engagements' | 'intents' | 'evidences' | 'assets'> = {
  spawns: 'engagements',
  yields: 'intents',
  derived_from: 'evidences',
  proves: 'intents',
  supports: 'evidences',
  parent: 'assets',
}

/** The target table an edge kind points at. */
const TARGET_TABLE_OF_EDGE: Record<CodeauditEdgeKind, 'intents' | 'evidences' | 'findings' | 'assets'> = {
  spawns: 'intents',
  yields: 'evidences',
  derived_from: 'intents',
  proves: 'findings',
  supports: 'findings',
  parent: 'assets',
}

/** Cordis companion plugin name. */
export const name = 'dsh-codeaudit-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Install the audit-graph checks against the open codeaudit domain. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('domain/changed', (change: DomainChanged) => {
    if (change.domain !== DOMAIN_NAME || change.operation !== 'put') return
    const domain = ctx.storage.form('domain').get(DOMAIN_NAME)
    if (domain === undefined) {
      return fail(`domain/changed for '${DOMAIN_NAME}' emitted while that domain is not open`)
    }
    if (change.table === 'engagements') {
      const engagement = change.value as { readonly sessionId: string }
      if (engagement.sessionId !== change.key) {
        return fail(`engagements row key '${change.key}' does not match its sessionId`)
      }
      return
    }
    if (!ENGAGEMENT_OWNED_TABLES.includes(change.table as typeof ENGAGEMENT_OWNED_TABLES[number])) return
    const record = change.value as { readonly sessionId: string }
    const engagement = [...domain.table('engagements').entries()].find(([, row]) =>
      (row as { readonly sessionId?: string }).sessionId === record.sessionId)
    if (engagement === undefined) {
      return fail(`'${DOMAIN_NAME}'.'${change.table}'['${change.key}'] references unknown session '${record.sessionId}'`)
    }
    const sameSession = (tableName: 'engagements' | 'intents' | 'evidences' | 'findings' | 'assets', id: string): boolean => {
      if (tableName === 'engagements') {
        return (engagement[1] as { readonly id?: string }).id === id
      }
      const row = (domain.table(tableName).get(recordKey(record.sessionId, id)) ?? domain.table(tableName).get(id)) as { readonly sessionId?: string } | undefined
      return row !== undefined && row.sessionId === record.sessionId
    }
    if (change.table === 'edges') {
      const edge = record as unknown as { readonly kind: CodeauditEdgeKind; readonly sourceId: string; readonly targetId: string }
      if (!sameSession(SOURCE_TABLE_OF_EDGE[edge.kind], edge.sourceId)) {
        return fail(`'${DOMAIN_NAME}'.edges['${change.key}'] ${edge.kind} source '${edge.sourceId}' is not a same-session ${SOURCE_TABLE_OF_EDGE[edge.kind]} row`)
      }
      if (!sameSession(TARGET_TABLE_OF_EDGE[edge.kind], edge.targetId)) {
        return fail(`'${DOMAIN_NAME}'.edges['${change.key}'] ${edge.kind} target '${edge.targetId}' is not a same-session ${TARGET_TABLE_OF_EDGE[edge.kind]} row`)
      }
      return
    }
    if (change.table === 'findings') {
      const affectedAssetId = (record as { readonly affectedAssetId?: string }).affectedAssetId
      if (affectedAssetId !== undefined && !sameSession('assets', affectedAssetId)) {
        return fail(`'${DOMAIN_NAME}'.findings['${change.key}'] references unknown asset '${affectedAssetId}'`)
      }
      // The evidence chain materializes as `supports` edge rows (validated in
      // the edges branch above); the finding record itself carries no ids.
    }
  }, { global: true })
}, { inject: ['storage'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
