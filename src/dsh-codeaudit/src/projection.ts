/**
 * The standing `codeaudit` session-projection unit: folds the logged
 * `codeaudit_*` tool calls into the engagement's current audit graph, so
 * the UI reconstructs the same graph from the session log alone — pure
 * mathematics, replay-safe, no storage-domain reads. Node/edge ids replicate
 * the store's deterministic `<kind>-<n>` counters, so edges resolve across the
 * fold. Writes that would violate the store's referential discipline are
 * skipped, mirroring the store's rejection. Malformed or foreign events leave
 * the state untouched.
 * @module dsh-codeaudit/src/projection
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { capPoc, capSnippet } from './spec.ts'
import type {
  CodeauditAssetType,
  CodeauditEdgeKind,
  CodeauditEvidenceKind,
  CodeauditFindingStatus,
  CodeauditSeverity,
} from './spec.ts'
import type {
  CodeauditProjection,
  CodeauditProjectionAsset,
  CodeauditProjectionEdge,
  CodeauditProjectionEngagement,
  CodeauditProjectionNode,
} from './types.ts'

/** Wire payload schema of the `codeaudit` projection (standing state or pre-init null). */
export const codeauditProjectionSchema: z.ZodType<CodeauditProjection | null> = z.union([
  z.object({
    engagement: z.object({
      id: z.string(),
      target: z.string(),
      objective: z.string(),
      scope: z.string(),
      stack: z.string(),
    }),
    nodes: z.array(z.union([
      z.object({
        id: z.string(),
        kind: z.literal('intent'),
        title: z.string(),
        detail: z.string(),
      }),
      z.object({
        id: z.string(),
        kind: z.literal('evidence'),
        evidenceKind: z.enum(['entry', 'sink', 'dataflow', 'sanitizer', 'config', 'dependency', 'info']),
        intentId: z.string(),
        location: z.string(),
        detail: z.string(),
        snippet: z.string(),
        confidence: z.number(),
      }),
      z.object({
        id: z.string(),
        kind: z.literal('finding'),
        intentId: z.string(),
        title: z.string(),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
        status: z.enum(['confirmed', 'suspected']),
        cwe: z.string(),
        description: z.string(),
        location: z.string(),
        snippet: z.string(),
        poc: z.string(),
        fix: z.string(),
        evidenceIds: z.array(z.string()),
        affectedAssetId: z.union([z.string(), z.undefined()]),
      }),
    ])),
    assets: z.array(z.object({
      id: z.string(),
      type: z.enum(['repo', 'module', 'file', 'class', 'function', 'endpoint', 'config', 'dependency']),
      value: z.string(),
      meta: z.string(),
    })),
    edges: z.array(z.object({
      id: z.string(),
      kind: z.enum(['spawns', 'yields', 'derived_from', 'proves', 'supports', 'parent']),
      sourceId: z.string(),
      targetId: z.string(),
    })),
    counts: z.object({
      intents: z.number().int().nonnegative(),
      evidences: z.number().int().nonnegative(),
      findings: z.number().int().nonnegative(),
      assets: z.number().int().nonnegative(),
    }),
  }),
  z.null(),
])

/** How many nodes/assets/edges the standing projection retains (oldest kept). */
export const NODE_CAP = 200
export const EDGE_CAP = 200
export const ASSET_CAP = 200

/** Per-kind per-session counters replicating the store's deterministic ids. */
export interface CodeauditFoldCounters {
  intent: number
  evidence: number
  finding: number
  asset: number
  edge: number
}

/** Fold state of the `codeaudit` unit (the standing audit graph). */
export interface CodeauditFoldState {
  engagement: CodeauditProjectionEngagement | null
  nodes: CodeauditProjectionNode[]
  assets: CodeauditProjectionAsset[]
  edges: CodeauditProjectionEdge[]
  counters: CodeauditFoldCounters
}

/** Initial state: an uninitialized engagement (view projects to null). */
export const codeauditInitialState: CodeauditFoldState = {
  engagement: null,
  nodes: [],
  assets: [],
  edges: [],
  counters: { intent: 0, evidence: 0, finding: 0, asset: 0, edge: 0 },
}

/** The closed enum values of the wire payloads. */
const EVIDENCE_KINDS: ReadonlySet<string> = new Set(['entry', 'sink', 'dataflow', 'sanitizer', 'config', 'dependency', 'info'])
const SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low', 'info'])
const ASSET_TYPES: ReadonlySet<string> = new Set(['repo', 'module', 'file', 'class', 'function', 'endpoint', 'config', 'dependency'])
const STATUSES: ReadonlySet<string> = new Set(['confirmed', 'suspected'])

/** Read one tool call's raw arguments as an object, or undefined when absent/malformed. */
function argsOf(event: SessionEvent): Record<string, unknown> | undefined {
  if (event.type !== 'tool/call' || !event.data.name.startsWith('codeaudit_')) return undefined
  try {
    const parsed: unknown = JSON.parse(event.data.arguments)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Read a string argument, or '' when absent/not a string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(1, Math.max(0, value > 1 ? value / 100 : value))
  if (typeof value === 'string') {
    const text = value.trim()
    const percent = text.endsWith('%')
    const parsed = Number(percent ? text.slice(0, -1) : text)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(1, Math.max(0, percent || parsed > 1 ? parsed / 100 : parsed))
  }
  return 0.5
}

/** Retain only edges whose endpoints are still present in the capped graph. */
function retainedEdges(
  state: CodeauditFoldState,
  nodes: readonly CodeauditProjectionNode[],
  assets: readonly CodeauditProjectionAsset[],
  edges: readonly CodeauditProjectionEdge[],
): CodeauditProjectionEdge[] {
  const ids = new Set([state.engagement?.id, ...nodes.map(node => node.id), ...assets.map(asset => asset.id)])
  return edges.filter(edge => ids.has(edge.sourceId) && ids.has(edge.targetId))
}

/** Append a node and its edge, capped (oldest dropped). */
function withNode(
  state: CodeauditFoldState,
  edgeKind: CodeauditEdgeKind,
  sourceId: string,
  node: CodeauditProjectionNode,
  counters: CodeauditFoldCounters,
): CodeauditFoldState {
  const edge: CodeauditProjectionEdge = {
    id: `edge-${counters.edge + 1}`,
    kind: edgeKind,
    sourceId,
    targetId: node.id,
  }
  const nodes = [...state.nodes, node].slice(-NODE_CAP)
  const edges = retainedEdges(state, nodes, state.assets, [...state.edges, edge].slice(-EDGE_CAP))
  return {
    ...state,
    counters: { ...counters, edge: counters.edge + 1 },
    nodes,
    edges,
  }
}

/**
 * Append a finding and its full edge set — proves first, then one supports
 * edge per referenced evidence in evidenceIds order — replicating the store's
 * allocation order exactly, capped (oldest dropped).
 */
function withFinding(
  state: CodeauditFoldState,
  node: CodeauditProjectionNode & { kind: 'finding' },
  counters: CodeauditFoldCounters,
): CodeauditFoldState {
  const anchors: Array<{ readonly kind: CodeauditEdgeKind; readonly sourceId: string }> = [
    { kind: 'proves', sourceId: node.intentId },
    ...node.evidenceIds.map(evidenceId => ({ kind: 'supports' as const, sourceId: evidenceId })),
  ]
  let nextCounters = { ...counters }
  let edges = state.edges
  const nodes = [...state.nodes, node].slice(-NODE_CAP)
  const newEdges: CodeauditProjectionEdge[] = []
  for (const anchor of anchors) {
    nextCounters = { ...nextCounters, edge: nextCounters.edge + 1 }
    newEdges.push({ id: `edge-${nextCounters.edge}`, kind: anchor.kind, sourceId: anchor.sourceId, targetId: node.id })
  }
  edges = retainedEdges(state, nodes, state.assets, [...edges, ...newEdges].slice(-EDGE_CAP))
  return { ...state, counters: nextCounters, nodes, edges }
}

/** Append an asset and its optional parent edge, capped (oldest dropped). */
function withAsset(
  state: CodeauditFoldState,
  asset: CodeauditProjectionAsset,
  parentId: string | undefined,
  counters: CodeauditFoldCounters,
): CodeauditFoldState {
  const assets = [...state.assets, asset].slice(-ASSET_CAP)
  if (parentId === undefined) return { ...state, counters, assets }
  const edge: CodeauditProjectionEdge = {
    id: `edge-${counters.edge + 1}`,
    kind: 'parent',
    sourceId: parentId,
    targetId: asset.id,
  }
  return {
    ...state,
    counters: { ...counters, edge: counters.edge + 1 },
    assets,
    edges: retainedEdges(state, state.nodes, assets, [...state.edges, edge].slice(-EDGE_CAP)),
  }
}

/** The next deterministic id of one node kind (the engagement is fixed as `engagement-1`). */
function nextNodeId(state: CodeauditFoldState, kind: 'intent' | 'evidence' | 'finding' | 'asset'): {
  id: string
  counters: CodeauditFoldCounters
} {
  const counters = { ...state.counters, [kind]: state.counters[kind] + 1 }
  return { id: `${kind}-${counters[kind]}`, counters }
}

/** Look up an existing folded node by id and kind. */
function findNode(state: CodeauditFoldState, id: string, kind: 'intent' | 'evidence'): CodeauditProjectionNode | undefined {
  return state.nodes.find(node => node.id === id && node.kind === kind)
}

/** Fold one session event into the standing codeaudit state (pure, replay-safe). */
export function applyCodeauditEvent(state: CodeauditFoldState, event: SessionEvent): CodeauditFoldState {
  if (event.type !== 'tool/call') return state
  const args = argsOf(event)
  if (args === undefined) return state
  switch (event.data.name) {
    case 'codeaudit_set_engagement': {
      const target = str(args.target)
      const objective = str(args.objective)
      if (target === '' || objective === '') return state
      return {
        engagement: { id: 'engagement-1', target, objective, scope: str(args.scope), stack: str(args.stack) },
        nodes: [],
        assets: [],
        edges: [],
        counters: { intent: 0, evidence: 0, finding: 0, asset: 0, edge: 0 },
      }
    }
    case 'codeaudit_add_intent': {
      const title = str(args.title)
      const detail = str(args.detail)
      if (title === '') return state
      const engagementId = str(args.engagementId)
      const derivedFromEvidenceId = str(args.derivedFromEvidenceId)
      const anchors = (engagementId !== '' ? 1 : 0) + (derivedFromEvidenceId !== '' ? 1 : 0)
      if (anchors !== 1) return state
      if (engagementId !== '') {
        if (state.engagement === null || engagementId !== state.engagement.id) return state
        const { id, counters } = nextNodeId(state, 'intent')
        return withNode(state, 'spawns', engagementId, { id, kind: 'intent', title, detail }, counters)
      }
      if (findNode(state, derivedFromEvidenceId, 'evidence') === undefined) return state
      const { id: derivedId, counters: derivedCounters } = nextNodeId(state, 'intent')
      return withNode(state, 'derived_from', derivedFromEvidenceId, { id: derivedId, kind: 'intent', title, detail }, derivedCounters)
    }
    case 'codeaudit_add_evidence': {
      const intentId = str(args.intentId)
      if (findNode(state, intentId, 'intent') === undefined) return state
      const detail = str(args.detail)
      if (detail === '') return state
      const kind = typeof args.kind === 'string' && EVIDENCE_KINDS.has(args.kind) ? args.kind as CodeauditEvidenceKind : 'info'
      const confidence = normalizeConfidence(args.confidence)
      const { id, counters } = nextNodeId(state, 'evidence')
      const node: CodeauditProjectionNode = {
        id,
        kind: 'evidence',
        evidenceKind: kind,
        intentId,
        location: str(args.location),
        detail,
        snippet: capSnippet(str(args.snippet)),
        confidence,
      }
      return withNode(state, 'yields', intentId, node, counters)
    }
    case 'codeaudit_add_finding': {
      const intentId = str(args.intentId)
      if (findNode(state, intentId, 'intent') === undefined) return state
      const title = str(args.title)
      if (title === '') return state
      const location = str(args.location)
      if (location === '') return state
      const severity = typeof args.severity === 'string' && SEVERITIES.has(args.severity) ? args.severity as CodeauditSeverity : 'info'
      const status = typeof args.status === 'string' && STATUSES.has(args.status) ? args.status as CodeauditFindingStatus : 'suspected'
      const evidenceIds = Array.isArray(args.evidenceIds)
        ? args.evidenceIds.filter((evidenceId): evidenceId is string => typeof evidenceId === 'string' && evidenceId !== '')
        : []
      if (evidenceIds.length === 0) return state
      if (!evidenceIds.every(evidenceId => findNode(state, evidenceId, 'evidence') !== undefined)) return state
      const affectedAssetId = str(args.affectedAssetId)
      if (affectedAssetId !== '' && !state.assets.some(asset => asset.id === affectedAssetId)) return state
      const { id, counters } = nextNodeId(state, 'finding')
      const node: CodeauditProjectionNode & { kind: 'finding' } = {
        id,
        kind: 'finding',
        intentId,
        title,
        severity,
        status,
        cwe: str(args.cwe),
        description: str(args.description),
        location,
        snippet: capSnippet(str(args.snippet)),
        poc: capPoc(str(args.poc)),
        fix: str(args.fix),
        evidenceIds,
        affectedAssetId: affectedAssetId === '' ? undefined : affectedAssetId,
      }
      return withFinding(state, node, counters)
    }
    case 'codeaudit_add_asset': {
      const type = typeof args.type === 'string' && ASSET_TYPES.has(args.type) ? args.type as CodeauditAssetType : undefined
      if (type === undefined) return state
      const value = str(args.value)
      if (value === '') return state
      const parentId = str(args.parentId)
      if (parentId !== '' && !state.assets.some(asset => asset.id === parentId)) return state
      const { id, counters } = nextNodeId(state, 'asset')
      const asset: CodeauditProjectionAsset = { id, type, value, meta: str(args.meta) }
      return withAsset(state, asset, parentId === '' ? undefined : parentId, counters)
    }
    default:
      return state
  }
}

/** Project the fold state onto the wire payload (null before the first engagement). */
export function viewCodeauditState(state: CodeauditFoldState): CodeauditProjection | null {
  if (state.engagement === null) return null
  return {
    engagement: state.engagement,
    nodes: state.nodes,
    assets: state.assets,
    edges: state.edges,
    counts: {
      intents: state.nodes.filter(node => node.kind === 'intent').length,
      evidences: state.nodes.filter(node => node.kind === 'evidence').length,
      findings: state.nodes.filter(node => node.kind === 'finding').length,
      assets: state.assets.length,
    },
  }
}
