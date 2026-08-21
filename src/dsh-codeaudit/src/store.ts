/**
 * In-memory-forwarding, durably-backed store for codeaudit audit records.
 *
 * Reads are synchronous from the authoritative in-memory state (as served by
 * the storage-domain facility); writes are queued per-domain, persisted to the
 * routed backend first, then applied to memory and emitted via `domain/changed`.
 * The domain is opened lazily on first use and closed on plugin dispose.
 *
 * The store owns the audit discipline: one engagement per session (a new
 * engagement resets the whole graph), every node/edge write validates its
 * references against the same session, every finding lands with its full
 * evidence chain (proves edge from the intent plus one supports edge per
 * referenced evidence), and node/edge ids are deterministic (`<kind>-<n>`,
 * per-session counters) so the session projection can replicate the graph
 * purely from the logged tool calls.
 * @module dsh-codeaudit/src/store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  codeauditDomainSpec,
  type CodeauditAsset,
  type CodeauditAssetType,
  type CodeauditEdge,
  type CodeauditEdgeKind,
  type CodeauditEngagement,
  type CodeauditEvidence,
  type CodeauditEvidenceKind,
  type CodeauditFinding,
  type CodeauditFindingStatus,
  type CodeauditIntent,
  type CodeauditSeverity,
} from './spec.ts'

/** Deterministic id namespace per node/edge kind (ids read `<kind>-<n>`). */
type IdKind = 'engagement' | 'intent' | 'evidence' | 'finding' | 'asset' | 'edge'

/** The record table owning each id kind. */
const TABLE_OF_ID_KIND = {
  engagement: 'engagements',
  intent: 'intents',
  evidence: 'evidences',
  finding: 'findings',
  asset: 'assets',
  edge: 'edges',
} as const satisfies Record<IdKind, string>

const SESSION_SCOPED_TABLES = ['intents', 'evidences', 'findings', 'assets', 'edges'] as const

/** Physical key for a session-local graph node or edge. */
function recordKey(sessionId: string, id: string): string {
  return `${sessionId}:${id}`
}

/** Copy and freeze one record before it crosses the service boundary. */
function snapshot<T extends object>(value: T): T {
  return Object.freeze({ ...value })
}

/** Options for creating (or resetting) one session's audit engagement. */
export interface EngagementInput {
  readonly target: string
  readonly objective: string
  /** Scope/exclusions note; empty when the caller supplied none. */
  readonly scope: string
  /** Stack summary recorded during mapping; empty when unknown. */
  readonly stack: string
}

/** Options for recording one audit intent (exactly one anchor required). */
export interface IntentInput {
  readonly title: string
  readonly detail: string
  /** Anchor of a `spawns` edge: the engagement the intent works toward. */
  readonly engagementId?: string
  /** Anchor of a `derived_from` edge: the evidence the intent builds on. */
  readonly derivedFromEvidenceId?: string
}

/** Options for recording one evidence yielded by an intent. */
export interface EvidenceInput {
  readonly intentId: string
  readonly kind: CodeauditEvidenceKind
  readonly location: string
  readonly detail: string
  readonly snippet: string
  readonly confidence: number
}

/** Options for recording one vulnerability finding proved by an intent. */
export interface FindingInput {
  readonly intentId: string
  readonly title: string
  readonly severity: CodeauditSeverity
  readonly status: CodeauditFindingStatus
  readonly cwe: string
  readonly description: string
  readonly location: string
  readonly snippet: string
  readonly poc: string
  readonly pocNote: string
  readonly fix: string
  /** The evidence chain backing the finding (min one; supports edges). */
  readonly evidenceIds: readonly string[]
  readonly affectedAssetId?: string
}

/** Options for recording one asset (optionally parented to another asset). */
export interface AssetInput {
  readonly type: CodeauditAssetType
  readonly value: string
  readonly parentId?: string
  readonly meta: string
}

/** The model-visible state of one session's audit. */
export interface CodeauditStateView {
  readonly initialized: boolean
  readonly engagement?: CodeauditEngagement
  readonly intents: CodeauditIntent[]
  readonly evidences: CodeauditEvidence[]
  readonly findings: CodeauditFinding[]
  readonly assets: CodeauditAsset[]
  readonly edges: CodeauditEdge[]
  readonly counts: { intents: number; evidences: number; findings: number; assets: number }
}

/** One newly minted node and its optional connecting edge. */
export interface NodeWrite {
  readonly nodeId: string
  /** The edge linking the anchor to the new node; absent for root assets. */
  readonly edge?: { readonly id: string; readonly kind: CodeauditEdgeKind; readonly sourceId: string; readonly targetId: string }
}

/** One finding write: the node plus every edge it created (proves first, then supports in evidenceIds order). */
export interface FindingWrite {
  readonly nodeId: string
  readonly edgeIds: readonly string[]
}

/** The ids a delegated submission was assigned, returned so the caller never has to guess them. */
export interface SubmissionWrite {
  readonly evidenceIds: readonly string[]
  readonly assetIds: readonly string[]
  readonly findingIds: readonly string[]
}

/**
 * Owning handle for the lazily opened codeaudit domain. Not a Cordis service:
 * it is a private helper owned by the plugin `apply` fiber and disposed with
 * it.
 */
export class CodeauditStore {
  private domainPromise: Promise<Domain<typeof codeauditDomainSpec>> | undefined
  private readonly sessionQueues = new Map<string, Promise<void>>()
  /** Per-session max id sequence per kind, mirroring the durable tables. */
  private readonly sessionCounters = new Map<string, Map<IdKind, number>>()

  constructor(private readonly ctx: Context) {}

  /** Resolve the opened domain, opening it lazily on first use. */
  private domain(): Promise<Domain<typeof codeauditDomainSpec>> {
    if (this.domainPromise === undefined) {
      this.domainPromise = this.ctx.storageDomain.open(codeauditDomainSpec).then(async domain => {
        await this.migrateLegacyKeys(domain)
        return domain
      })
    }
    return this.domainPromise
  }

  /** Move legacy global-id rows to the session-scoped key format once. */
  private async migrateLegacyKeys(domain: Domain<typeof codeauditDomainSpec>): Promise<void> {
    for (const name of SESSION_SCOPED_TABLES) {
      const table = domain.table(name)
      for (const [key, row] of table.entries()) {
        const record = row as { sessionId: string; id: string }
        const scopedKey = recordKey(record.sessionId, record.id)
        if (key === scopedKey) continue
        if (table.get(scopedKey) === undefined) await table.put(scopedKey, row)
        await table.delete(key)
      }
    }
  }

  /** Close the domain and release its backend unit (idempotent). */
  async dispose(): Promise<void> {
    // Drain queued writes before closing the domain. Keep domainPromise intact
    // while draining so an in-flight operation cannot reopen a second domain.
    await Promise.all([...this.sessionQueues.values()])
    const pending = this.domainPromise
    if (pending !== undefined) {
      this.domainPromise = undefined
      await (await pending).close()
    }
    this.sessionQueues.clear()
    this.sessionCounters.clear()
  }

  /** Serialize read/allocate/write transactions for one session. */
  private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve()
    const current = previous.then(async () => {
      // A rolled-back write must not advance the id counters: the session
      // projection replicates ids by folding only the LOGGED (successful)
      // tool calls, so a counter consumed by a failed attempt would fork the
      // store's ids away from the fold's ids — the UI would stop showing
      // records the store (and the report) still holds.
      const counters = this.sessionCounters.get(sessionId)
      const snapshot = counters === undefined ? undefined : new Map(counters)
      try {
        return await operation()
      } catch (error) {
        if (snapshot === undefined) this.sessionCounters.delete(sessionId)
        else this.sessionCounters.set(sessionId, snapshot)
        throw error
      }
    })
    const settled = current.then(() => undefined, () => undefined)
    this.sessionQueues.set(sessionId, settled)
    return current
  }

  /** Read one session's engagement row, if present. */
  async getEngagement(sessionId: string): Promise<CodeauditEngagement | undefined> {
    return (await this.domain()).table('engagements').get(sessionId)
  }

  /** Read the engagement row, failing with a guiding error when absent. */
  private async requireEngagement(sessionId: string): Promise<CodeauditEngagement> {
    const engagement = await this.getEngagement(sessionId)
    if (engagement === undefined) {
      throw new Error('codeaudit engagement is not initialized; call codeaudit_set_engagement with target and objective first')
    }
    return engagement
  }

  /**
   * The next deterministic id for one kind in one session. Allocation is O(1)
   * from the in-memory max-sequence cache (the store is the domain's single
   * writer, and every allocation runs inside the session's serialized queue);
   * the cache is (re)built from the durable table on first touch of a session
   * and dropped wholesale when the session's engagement resets.
   */
  private async nextId(kind: IdKind, sessionId: string): Promise<string> {
    let counters = this.sessionCounters.get(sessionId)
    if (counters === undefined) {
      counters = new Map()
      for (const name of SESSION_SCOPED_TABLES) {
        const table = (await this.domain()).table(name)
        for (const [, row] of table.entries()) {
          const record = row as { sessionId: string; id: string }
          if (record.sessionId !== sessionId) continue
          const [kindOfId, seq] = /^([a-z]+)-(\d+)$/.exec(record.id)?.slice(1) ?? []
          if (kindOfId === undefined || seq === undefined) continue
          if (kindOfId === 'intent' || kindOfId === 'evidence' || kindOfId === 'finding' || kindOfId === 'asset' || kindOfId === 'edge') {
            counters.set(kindOfId, Math.max(counters.get(kindOfId) ?? 0, Number(seq)))
          }
        }
      }
      this.sessionCounters.set(sessionId, counters)
    }
    const next = (counters.get(kind) ?? 0) + 1
    counters.set(kind, next)
    return `${kind}-${next}`
  }

  /** Delete every audit row of one session (engagement reset). */
  private async clearSession(sessionId: string): Promise<void> {
    const domain = await this.domain()
    for (const name of SESSION_SCOPED_TABLES) {
      const table = domain.table(name)
      for (const [key, row] of table.entries()) {
        if ((row as { sessionId: string }).sessionId === sessionId) await table.delete(key)
      }
    }
  }

  /**
   * Create, update, or reset the audit engagement. Re-declaring the SAME
   * target and objective only updates scope/stack (late stack fills must not
   * wipe the recorded chain); a genuinely different engagement clears the
   * whole audit graph of the session and restarts fresh counters.
   */
  async initEngagement(sessionId: string, input: EngagementInput): Promise<CodeauditEngagement> {
    return this.enqueue(sessionId, async () => {
      const existing = await this.getEngagement(sessionId)
      if (existing !== undefined && existing.target === input.target && existing.objective === input.objective) {
        const updated = snapshot<CodeauditEngagement>({
          ...existing,
          scope: input.scope === '' ? existing.scope : input.scope,
          stack: input.stack === '' ? existing.stack : input.stack,
        })
        await (await this.domain()).table('engagements').put(sessionId, updated)
        return updated
      }
      const engagement = snapshot<CodeauditEngagement>({
        id: 'engagement-1',
        sessionId,
        target: input.target,
        objective: input.objective,
        scope: input.scope,
        stack: input.stack,
      })
      await (await this.domain()).table('engagements').put(sessionId, engagement)
      await this.clearSession(sessionId)
      // A fresh engagement restarts every per-session counter.
      this.sessionCounters.delete(sessionId)
      return engagement
    })
  }

  /** Validate a reference row (same session, expected table) or fail loud. */
  private async requireRef(
    sessionId: string,
    tableName: 'engagements' | 'intents' | 'evidences' | 'findings' | 'assets',
    refId: string,
    label: string,
  ): Promise<void> {
    const row = (await this.domain()).table(tableName).get(recordKey(sessionId, refId))
    if (row === undefined) {
      throw new Error(`codeaudit: unknown ${label} ${refId}`)
    }
    /* v8 ignore next -- session-scoped keys are normalized on domain open and the domain has one writer. */
    if (row.sessionId !== sessionId) {
      throw new Error(`codeaudit: ${label} ${refId} belongs to another session`)
    }
  }

  /** Mint one node (and its connecting edge) in one write. */
  private async addNode(
    sessionId: string,
    edgeKind: CodeauditEdgeKind | undefined,
    sourceId: string,
    nodeKind: 'intent' | 'evidence' | 'asset',
    node: Omit<CodeauditIntent | CodeauditEvidence | CodeauditAsset, 'id' | 'sessionId'>,
  ): Promise<NodeWrite> {
    const domain = await this.domain()
    const nodeId = await this.nextId(nodeKind, sessionId)
    const record = snapshot({ id: nodeId, sessionId, ...node }) as CodeauditIntent | CodeauditEvidence | CodeauditAsset
    await domain.table(TABLE_OF_ID_KIND[nodeKind]).put(recordKey(sessionId, nodeId), record)
    if (edgeKind === undefined) return { nodeId }
    const edgeId = await this.nextId('edge', sessionId)
    const edge = snapshot<CodeauditEdge>({ id: edgeId, sessionId, kind: edgeKind, sourceId, targetId: nodeId })
    try {
      await domain.table('edges').put(recordKey(sessionId, edgeId), edge)
    } catch (error) {
      await domain.table(TABLE_OF_ID_KIND[nodeKind]).delete(recordKey(sessionId, nodeId))
      throw error
    }
    return { nodeId, edge: { id: edgeId, kind: edgeKind, sourceId, targetId: nodeId } }
  }

  /**
   * Mint one finding with its full edge set: the `proves` edge from the
   * intent, then one `supports` edge per referenced evidence (in evidenceIds
   * order). Edge allocation order is part of the projection contract — the
   * fold replicates it exactly. Any write failure rolls back the node and
   * every edge already written.
   */
  private async writeFinding(sessionId: string, input: FindingInput): Promise<FindingWrite> {
    const domain = await this.domain()
    const nodeId = await this.nextId('finding', sessionId)
    const finding = snapshot<CodeauditFinding>({
      id: nodeId,
      sessionId,
      intentId: input.intentId,
      title: input.title,
      severity: input.severity,
      status: input.status,
      cwe: input.cwe,
      description: input.description,
      location: input.location,
      snippet: input.snippet,
      poc: input.poc,
      pocNote: input.pocNote,
      fix: input.fix,
      ...(input.affectedAssetId !== undefined ? { affectedAssetId: input.affectedAssetId } : {}),
    })
    await domain.table('findings').put(recordKey(sessionId, nodeId), finding)
    const anchors: Array<{ readonly kind: CodeauditEdgeKind; readonly sourceId: string }> = [
      { kind: 'proves', sourceId: input.intentId },
      ...input.evidenceIds.map(evidenceId => ({ kind: 'supports' as const, sourceId: evidenceId })),
    ]
    const edgeIds: string[] = []
    try {
      for (const anchor of anchors) {
        const edgeId = await this.nextId('edge', sessionId)
        const edge = snapshot<CodeauditEdge>({ id: edgeId, sessionId, kind: anchor.kind, sourceId: anchor.sourceId, targetId: nodeId })
        await domain.table('edges').put(recordKey(sessionId, edgeId), edge)
        edgeIds.push(edgeId)
      }
    } catch (error) {
      for (const edgeId of edgeIds.reverse()) {
        try {
          await domain.table('edges').delete(recordKey(sessionId, edgeId))
        } catch {
          // Rollback already lost the race with a failing backend; the
          // original error is the actionable one.
        }
      }
      try {
        await domain.table('findings').delete(recordKey(sessionId, nodeId))
      } catch {
        // Same as above: the original error must survive.
      }
      throw error
    }
    return { nodeId, edgeIds }
  }

  /** Validate one finding's references (used ahead of writes by both paths). */
  private async validateFindingRefs(sessionId: string, finding: FindingInput): Promise<void> {
    await this.requireRef(sessionId, 'intents', finding.intentId, 'intent')
    if (finding.evidenceIds.length === 0) {
      throw new Error('codeaudit_add_finding requires at least one evidence reference (evidenceIds)')
    }
    for (const evidenceId of finding.evidenceIds) {
      await this.requireRef(sessionId, 'evidences', evidenceId, 'evidence')
    }
    if (finding.affectedAssetId !== undefined) await this.requireRef(sessionId, 'assets', finding.affectedAssetId, 'asset')
  }

  /** Record one intent spawned by the engagement or derived from an evidence. */
  async addIntent(sessionId: string, input: IntentInput): Promise<NodeWrite> {
    const anchors = (input.engagementId !== undefined ? 1 : 0) + (input.derivedFromEvidenceId !== undefined ? 1 : 0)
    if (anchors !== 1) {
      throw new Error('codeaudit_add_intent requires exactly one anchor: engagementId (spawns) or derivedFromEvidenceId (derived_from)')
    }
    return this.enqueue(sessionId, async () => {
      const engagement = await this.requireEngagement(sessionId)
      if (input.engagementId !== undefined) {
        if (input.engagementId !== engagement.id) throw new Error(`codeaudit: unknown engagement ${input.engagementId}`)
        return this.addNode(sessionId, 'spawns', input.engagementId, 'intent', { title: input.title, detail: input.detail })
      }
      const derivedFromEvidenceId = input.derivedFromEvidenceId ?? ''
      await this.requireRef(sessionId, 'evidences', derivedFromEvidenceId, 'evidence')
      return this.addNode(sessionId, 'derived_from', derivedFromEvidenceId, 'intent', { title: input.title, detail: input.detail })
    })
  }

  /** Record one evidence yielded by an intent. */
  async addEvidence(sessionId: string, input: EvidenceInput): Promise<NodeWrite> {
    return this.enqueue(sessionId, async () => {
      await this.requireEngagement(sessionId)
      await this.requireRef(sessionId, 'intents', input.intentId, 'intent')
      return this.addNode(sessionId, 'yields', input.intentId, 'evidence', {
        intentId: input.intentId,
        kind: input.kind,
        location: input.location,
        detail: input.detail,
        snippet: input.snippet,
        confidence: input.confidence,
      })
    })
  }

  /** Record one finding proved by an intent (with its evidence chain). */
  async addFinding(sessionId: string, input: FindingInput): Promise<FindingWrite> {
    return this.enqueue(sessionId, async () => {
      await this.requireEngagement(sessionId)
      await this.validateFindingRefs(sessionId, input)
      return this.writeFinding(sessionId, input)
    })
  }

  /** Record one asset; an optional parent links it into the asset graph. */
  async addAsset(sessionId: string, input: AssetInput): Promise<NodeWrite> {
    // An empty-string parentId means "root asset" (the model often sends the
    // field with '' instead of omitting it); only a non-empty id is a real
    // parent reference.
    const parentId = input.parentId === '' ? undefined : input.parentId
    return this.enqueue(sessionId, async () => {
      await this.requireEngagement(sessionId)
      if (parentId !== undefined) await this.requireRef(sessionId, 'assets', parentId, 'asset')
      return this.addNode(sessionId, parentId === undefined ? undefined : 'parent', parentId ?? '', 'asset', {
        type: input.type,
        value: input.value,
        meta: input.meta,
      })
    })
  }

  /** Persist one delegated submission as an all-or-nothing session write. */
  async addSubmission(
    sessionId: string,
    intentId: string,
    evidences: readonly EvidenceInput[],
    assets: readonly AssetInput[],
    findings: readonly FindingInput[],
  ): Promise<SubmissionWrite> {
    return this.enqueue(sessionId, async () => {
      await this.requireEngagement(sessionId)
      await this.requireRef(sessionId, 'intents', intentId, 'intent')
      for (const asset of assets) {
        const parentId = asset.parentId === '' ? undefined : asset.parentId
        if (parentId !== undefined) await this.requireRef(sessionId, 'assets', parentId, 'asset')
      }
      for (const finding of findings) {
        // Shape check ahead of writes; same-batch evidence references resolve
        // during the write (the evidences of this batch land first).
        if (finding.evidenceIds.length === 0) {
          throw new Error('codeaudit_add_finding requires at least one evidence reference (evidenceIds)')
        }
        if (finding.affectedAssetId !== undefined) await this.requireRef(sessionId, 'assets', finding.affectedAssetId, 'asset')
      }
      const created: Array<{ readonly kind: 'evidence' | 'asset' | 'finding'; readonly nodeId: string; readonly edgeIds: readonly string[] }> = []
      try {
        for (const evidence of evidences) {
          const write = await this.addNode(sessionId, 'yields', intentId, 'evidence', { ...evidence, intentId })
          created.push({ kind: 'evidence', nodeId: write.nodeId, edgeIds: write.edge === undefined ? [] : [write.edge.id] })
        }
        for (const asset of assets) {
          const parentId = asset.parentId === '' ? undefined : asset.parentId
          const write = await this.addNode(sessionId, parentId === undefined ? undefined : 'parent', parentId ?? '', 'asset', asset)
          created.push({ kind: 'asset', nodeId: write.nodeId, edgeIds: write.edge === undefined ? [] : [write.edge.id] })
        }
        for (const finding of findings) {
          await this.validateFindingRefs(sessionId, { ...finding, intentId })
          const write = await this.writeFinding(sessionId, { ...finding, intentId })
          created.push({ kind: 'finding', nodeId: write.nodeId, edgeIds: write.edgeIds })
        }
        return {
          evidenceIds: created.filter(row => row.kind === 'evidence').map(row => row.nodeId),
          assetIds: created.filter(row => row.kind === 'asset').map(row => row.nodeId),
          findingIds: created.filter(row => row.kind === 'finding').map(row => row.nodeId),
        }
      } catch (error) {
        const domain = await this.domain()
        for (const { kind, nodeId, edgeIds } of created.reverse()) {
          // Each cleanup failure is collected (not thrown) so the ORIGINAL
          // error survives and the remaining rows still get their best-effort
          // removal — a second backend failure must not strand the rest.
          for (const edgeId of [...edgeIds].reverse()) {
            try {
              await domain.table('edges').delete(recordKey(sessionId, edgeId))
            } catch {
              // Rollback already lost the race with a failing backend.
            }
          }
          try {
            await domain.table(TABLE_OF_ID_KIND[kind]).delete(recordKey(sessionId, nodeId))
          } catch {
            // Same as above: the original error is the actionable one.
          }
        }
        throw error
      }
    })
  }

  /** Read all audit rows of one session, ordered by numeric id sequence. */
  async sessionData(sessionId: string): Promise<{
    engagement: CodeauditEngagement | undefined
    intents: CodeauditIntent[]
    evidences: CodeauditEvidence[]
    findings: CodeauditFinding[]
    assets: CodeauditAsset[]
    edges: CodeauditEdge[]
  }> {
    const domain = await this.domain()
    const bySession = <T extends { readonly sessionId: string; readonly id: string }>(rows: Iterable<[string, T]>): T[] =>
      [...rows].map(([, row]) => row).filter(row => row.sessionId === sessionId).sort((a, b) => {
        const aSeq = Number(/-(\d+)$/.exec(a.id)?.[1] ?? Number.MAX_SAFE_INTEGER)
        const bSeq = Number(/-(\d+)$/.exec(b.id)?.[1] ?? Number.MAX_SAFE_INTEGER)
        return aSeq - bSeq
      })
    return {
      engagement: await this.getEngagement(sessionId),
      intents: bySession(domain.table('intents').entries()),
      evidences: bySession(domain.table('evidences').entries()),
      findings: bySession(domain.table('findings').entries()),
      assets: bySession(domain.table('assets').entries()),
      edges: bySession(domain.table('edges').entries()),
    }
  }

  /** Build the model-visible summary view for one session. */
  async view(sessionId: string): Promise<CodeauditStateView> {
    const { engagement, intents, evidences, findings, assets, edges } = await this.sessionData(sessionId)
    if (engagement === undefined) {
      return {
        initialized: false,
        intents: [],
        evidences: [],
        findings: [],
        assets: [],
        edges: [],
        counts: { intents: 0, evidences: 0, findings: 0, assets: 0 },
      }
    }
    return snapshot<CodeauditStateView>({
      initialized: true,
      engagement,
      intents,
      evidences,
      findings,
      assets,
      edges,
      counts: { intents: intents.length, evidences: evidences.length, findings: findings.length, assets: assets.length },
    })
  }
}
