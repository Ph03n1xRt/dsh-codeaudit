/**
 * Pure graph-layout helpers for the codeaudit view tabs.
 *
 * `buildExploreModel` aggregates the standing projection into what the
 * exploration graph actually draws: the engagement, the intents, the
 * findings, and — only for intents the user expanded — their evidences.
 * Edges of a collapsed evidence remap to its owning intent (supports →
 * intent→finding, derived_from → intent→intent; yields is absorbed), so the
 * collapsed skeleton still reads 任务 → 意图 → 漏洞 while a long audit stays
 * legible instead of turning into a 200-card blob.
 *
 * `layoutExploration` then positions that model (BFS depth layers, axes
 * swappable for vertical reading); `layoutAssets` layers the asset tree.
 * All pure functions of the standing projection — fully unit-testable, no
 * React Flow involvement.
 */

import type {
  CodeauditProjection,
  CodeauditProjectionEdge,
  CodeauditProjectionEngagement,
  CodeauditProjectionNode,
  CodeauditSeverity,
  CodeauditAssetType,
  CodeauditFindingStatus,
} from '../../../dsh-codeaudit/src/client.ts'

/** Node kinds drawn in the audit graph. */
export type ExploreNodeKind = 'engagement' | 'intent' | 'evidence' | 'finding'

/** Per-intent aggregate counts shown as badges (full counts, ignoring expansion). */
export interface IntentStats {
  readonly evidences: number
  readonly findings: number
}

/** The aggregated, expandable view model the exploration graph renders. */
export interface ExploreModel {
  readonly engagement: CodeauditProjectionEngagement | null
  /** The visible nodes: intents, findings, and the expanded intents' evidences. */
  readonly nodes: readonly CodeauditProjectionNode[]
  /** Visible edges with collapsed-evidence edges remapped to the owning intent. */
  readonly edges: readonly CodeauditProjectionEdge[]
  /** Full per-intent counts, by intent id. */
  readonly intentStats: ReadonlyMap<string, IntentStats>
}

/** One placed audit node (position in graph units, plus the drawer payload). */
export interface ExploreGraphNode {
  readonly id: string
  readonly kind: ExploreNodeKind
  readonly title: string
  readonly detail: string
  readonly severity: CodeauditSeverity | undefined
  readonly status: CodeauditFindingStatus | undefined
  readonly location: string
  readonly snippet: string
  /** Intent nodes: aggregate evidence count badge. */
  readonly evidenceCount: number
  /** Intent nodes: aggregate finding count badge. */
  readonly findingCount: number
  readonly x: number
  readonly y: number
}

/** One placed asset node (position in graph units). */
export interface AssetGraphNode {
  readonly id: string
  readonly type: CodeauditAssetType
  readonly value: string
  readonly meta: string
  readonly x: number
  readonly y: number
}

/** Fixed graph-card dimensions; layout spacing must leave room around them. */
export const EXPLORE_NODE_SIZE = { width: 236, height: 120 } as const
export const ASSET_NODE_SIZE = { width: 220, height: 100 } as const

/** The chain edge kinds (parent edges belong to the asset graph only). */
const CHAIN_EDGE_KINDS: ReadonlySet<string> = new Set(['spawns', 'yields', 'derived_from', 'proves', 'supports'])

/** Reading direction of the layered layout. */
export type LayoutOrientation = 'horizontal' | 'vertical'

/** Options of {@link layoutExploration}. */
export interface LayoutOptions {
  readonly orientation?: LayoutOrientation
}

/**
 * At or below this many nodes the graph starts fully expanded; beyond it the
 * evidences start collapsed into their intents (the skeleton stays readable;
 * any intent expands on demand).
 */
export const AUTO_EXPAND_MAX_NODES = 15

/**
 * The node ids lying on a path that ends at a finding (the finding itself,
 * its proving intent and supporting evidences, and every ancestor along
 * spawns/yields/derived_from edges). Dead-end exploration branches — intents
 * that never proved anything — drop out; used by the 仅漏洞链路 filter so a
 * long audit stays readable.
 */
export function findingChainIds(projection: CodeauditProjection): Set<string> {
  const sourcesOf = new Map<string, string[]>()
  for (const edge of projection.edges) {
    if (!CHAIN_EDGE_KINDS.has(edge.kind)) continue
    const list = sourcesOf.get(edge.targetId) ?? []
    list.push(edge.sourceId)
    sourcesOf.set(edge.targetId, list)
  }
  const keep = new Set<string>()
  const queue = projection.nodes
    .filter((node): node is CodeauditProjectionNode & { kind: 'finding' } => node.kind === 'finding')
    .map(node => node.id)
  for (const id of queue) {
    if (keep.has(id)) continue
    keep.add(id)
    for (const source of sourcesOf.get(id) ?? []) queue.push(source)
  }
  return keep
}

/**
 * Aggregate the projection into the expandable exploration model.
 *
 * Evidences of a collapsed intent drop out of `nodes`; their edges remap to
 * the owning intent (yields is absorbed; supports/derived_from re-anchor),
 * with parallel remapped edges de-duplicated. Edges referencing nodes the
 * model does not carry (e.g. a supports edge to a foreign evidence) drop.
 * @param projection - the (possibly finding-filtered) standing projection.
 * @param expanded - the intent ids whose evidences stay visible.
 */
export function buildExploreModel(projection: CodeauditProjection, expanded: ReadonlySet<string>): ExploreModel {
  const intents = projection.nodes.filter((node): node is CodeauditProjectionNode & { kind: 'intent' } => node.kind === 'intent')
  const evidences = projection.nodes.filter((node): node is CodeauditProjectionNode & { kind: 'evidence' } => node.kind === 'evidence')
  const findings = projection.nodes.filter((node): node is CodeauditProjectionNode & { kind: 'finding' } => node.kind === 'finding')

  const ownerOfEvidence = new Map(evidences.map(evidence => [evidence.id, evidence.intentId]))
  const evidenceVisible = (id: string): boolean => {
    const owner = ownerOfEvidence.get(id)
    return owner !== undefined && expanded.has(owner)
  }

  const intentStats = new Map<string, IntentStats>()
  for (const intent of intents) intentStats.set(intent.id, { evidences: 0, findings: 0 })
  for (const evidence of evidences) {
    const stats = intentStats.get(evidence.intentId)
    if (stats !== undefined) intentStats.set(evidence.intentId, { evidences: stats.evidences + 1, findings: stats.findings })
  }
  for (const finding of findings) {
    const stats = intentStats.get(finding.intentId)
    if (stats !== undefined) intentStats.set(finding.intentId, { evidences: stats.evidences, findings: stats.findings + 1 })
  }

  const visibleIds = new Set<string>([projection.engagement?.id ?? 'engagement-1'])
  for (const intent of intents) visibleIds.add(intent.id)
  for (const finding of findings) visibleIds.add(finding.id)
  for (const evidence of evidences) if (evidenceVisible(evidence.id)) visibleIds.add(evidence.id)

  // Remap edges whose source evidence is collapsed onto the owning intent;
  // de-duplicate parallel remapped edges; drop edges with missing endpoints.
  const seen = new Set<string>()
  const edges: CodeauditProjectionEdge[] = []
  for (const edge of projection.edges) {
    if (!CHAIN_EDGE_KINDS.has(edge.kind)) continue
    let { sourceId, targetId } = edge
    if (edge.kind === 'yields' && !evidenceVisible(targetId)) continue
    if ((edge.kind === 'derived_from' || edge.kind === 'supports') && !evidenceVisible(sourceId)) {
      const owner = ownerOfEvidence.get(sourceId)
      if (owner === undefined) continue
      sourceId = owner
    }
    if (!visibleIds.has(sourceId) || !visibleIds.has(targetId)) continue
    const dedupeKey = `${edge.kind}:${sourceId}→${targetId}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    edges.push({ ...edge, sourceId, targetId })
  }

  const nodes: CodeauditProjectionNode[] = [
    ...intents,
    ...evidences.filter(evidence => evidenceVisible(evidence.id)),
    ...findings,
  ]
  return { engagement: projection.engagement, nodes, edges, intentStats }
}

/** Semantic reading order of the node kinds: 任务 → 意图 → 证据 → 漏洞. */
const KIND_LEVEL: Record<ExploreNodeKind, number> = { engagement: 0, intent: 1, evidence: 2, finding: 3 }

/** Assign every reachable id a BFS depth from the roots; others hang below. */
function depthsOf(roots: readonly string[], edges: readonly CodeauditProjectionEdge[]): Map<string, number> {
  const depth = new Map<string, number>()
  // BFS over the edge list; `for..of` visits entries pushed while iterating,
  // so the queue grows in place without indexed access.
  const queue: Array<{ id: string; level: number }> = []
  for (const root of roots) {
    depth.set(root, 0)
    queue.push({ id: root, level: 0 })
  }
  for (const { id, level } of queue) {
    for (const edge of edges) {
      if (edge.sourceId !== id || depth.has(edge.targetId)) continue
      depth.set(edge.targetId, level + 1)
      queue.push({ id: edge.targetId, level: level + 1 })
    }
  }
  return depth
}

/** Stack items into columns by depth, assigning x/y positions (axes swap in vertical mode). */
function stackByDepth<T extends { readonly id: string }>(
  items: readonly T[],
  depth: ReadonlyMap<string, number>,
  columnGap: number,
  rowGap: number,
  vertical = false,
): Array<T & { readonly x: number; readonly y: number }> {
  const maxDepth = Math.max(0, ...depth.values())
  const rows = new Map<number, T[]>()
  for (const item of items) {
    const level = depth.get(item.id) ?? maxDepth + 1
    const row = rows.get(level) ?? []
    row.push(item)
    rows.set(level, row)
  }
  const placed: Array<T & { readonly x: number; readonly y: number }> = []
  for (const [level, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    for (const [index, item] of row.entries()) {
      placed.push(vertical
        ? { ...item, x: index * rowGap, y: level * columnGap }
        : { ...item, x: level * columnGap, y: index * rowGap })
    }
  }
  return placed
}

/** The display title of one folded node. */
function titleOf(node: CodeauditProjectionNode): string {
  switch (node.kind) {
    case 'intent': return node.title
    case 'evidence': return node.detail
    case 'finding': return node.title
  }
}

/** The display detail line of one folded node. */
function detailOf(node: CodeauditProjectionNode): string {
  switch (node.kind) {
    case 'intent': return node.detail
    case 'evidence': {
      const location = node.location === '' ? '' : `${node.location} `
      return `${location}[${node.evidenceKind}] · ${node.confidence}`
    }
    case 'finding': return node.description
  }
}

/** The code position carried into the detail drawer ('' for intents). */
function locationOf(node: CodeauditProjectionNode): string {
  return node.kind === 'evidence' || node.kind === 'finding' ? node.location : ''
}

/** The frozen code snippet carried into the detail drawer. */
function snippetOf(node: CodeauditProjectionNode): string {
  return node.kind === 'evidence' || node.kind === 'finding' ? node.snippet : ''
}

/**
 * Layered layout of the aggregated audit model with FIXED semantic levels:
 * 任务 (engagement) → 意图 (intent) → 证据 (evidence) → 漏洞 (finding). A
 * finding always sits one level deeper than the evidences and two deeper than
 * its proving intent, no matter how many derivation hops produced it. The
 * level axis compresses to the kinds actually visible, so a collapsed view
 * (evidences folded into their intents) leaves no empty evidence column.
 * Within a level, nodes of the same owning intent occupy adjacent rows
 * (intent order first, so each intent's cluster stays together). The orientation
 * picks the reading direction: horizontal places levels on the x axis (wide),
 * vertical on the y axis (tall — usually the better fit for a narrow side
 * panel carrying a long chain).
 * @param model - the aggregated exploration model.
 * @param options - layout options (orientation, default horizontal).
 * @returns the placed nodes and their chain edges.
 */
export function layoutExploration(model: ExploreModel, options: LayoutOptions = {}): {
  nodes: ExploreGraphNode[]
  edges: readonly CodeauditProjectionEdge[]
} {
  const vertical = options.orientation === 'vertical'
  const edges = model.edges
  const engagementId = model.engagement === null ? 'engagement-1' : model.engagement.id

  // Compress the semantic levels to the kinds actually visible.
  const present = [...new Set<number>([KIND_LEVEL.engagement, ...model.nodes.map(node => KIND_LEVEL[node.kind])])].sort((a, b) => a - b)
  const levelOfKind = (kind: ExploreNodeKind): number => present.indexOf(KIND_LEVEL[kind])

  // Lane keys: each intent's evidences/findings cluster under the intent.
  const intentOrder = new Map<string, number>()
  for (const node of model.nodes) {
    if (node.kind === 'intent') intentOrder.set(node.id, intentOrder.size)
  }
  const UNLANED = model.nodes.length + intentOrder.size + 1
  const laneOf = (node: CodeauditProjectionNode): Array<number> => {
    switch (node.kind) {
      case 'intent': return [intentOrder.get(node.id) ?? UNLANED, 0]
      case 'evidence': return [intentOrder.get(node.intentId) ?? UNLANED, 0]
      // Findings hang under their proving intent; unknown intents fall to the end.
      case 'finding': return [intentOrder.get(node.intentId) ?? UNLANED + 1, 0]
    }
  }

  const engagement: ExploreGraphNode = {
    id: engagementId,
    kind: 'engagement',
    title: model.engagement === null ? '' : model.engagement.target,
    detail: model.engagement === null ? '' : model.engagement.objective,
    severity: undefined,
    status: undefined,
    location: '',
    snippet: '',
    evidenceCount: 0,
    findingCount: 0,
    x: 0,
    y: 0,
  }
  const decorated = [
    { node: engagement, level: levelOfKind('engagement'), lane: [-1, 0] as Array<number>, seq: -1 },
    ...model.nodes.map((node, seq) => ({
      node: {
        id: node.id,
        kind: node.kind,
        title: titleOf(node),
        detail: detailOf(node),
        severity: node.kind === 'finding' ? node.severity : undefined,
        status: node.kind === 'finding' ? node.status : undefined,
        location: locationOf(node),
        snippet: snippetOf(node),
        evidenceCount: node.kind === 'intent' ? model.intentStats.get(node.id)?.evidences ?? 0 : 0,
        findingCount: node.kind === 'intent' ? model.intentStats.get(node.id)?.findings ?? 0 : 0,
      } as Omit<ExploreGraphNode, 'x' | 'y'>,
      level: levelOfKind(node.kind),
      lane: laneOf(node),
      seq,
    })),
  ]
  // Group by level; within a level, order by lane (parent intent) then model
  // order, so an intent's evidences/findings occupy adjacent rows.
  const byLevel = new Map<number, typeof decorated>()
  for (const item of decorated) {
    const list = byLevel.get(item.level) ?? []
    list.push(item)
    byLevel.set(item.level, list)
  }
  const columnGap = 320
  const rowGap = 152
  const nodes: ExploreGraphNode[] = []
  for (const [level, items] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    const ordered = [...items].sort((a, b) =>
      a.lane[0] !== b.lane[0] ? a.lane[0] - b.lane[0]
        : a.lane[1] !== b.lane[1] ? a.lane[1] - b.lane[1]
          : a.seq - b.seq)
    for (const [index, item] of ordered.entries()) {
      nodes.push({
        ...item.node,
        ...(vertical
          ? { x: index * rowGap, y: level * columnGap }
          : { x: level * columnGap, y: index * rowGap }),
      })
    }
  }
  return { nodes, edges }
}

/**
 * Layered layout of the asset graph: roots (assets without a parent edge) at
 * column 0, children one column deeper per parent hop.
 * @param projection - the standing codeaudit projection.
 * @returns the placed asset nodes and their parent edges.
 */
export function layoutAssets(projection: CodeauditProjection): {
  nodes: AssetGraphNode[]
  edges: CodeauditProjectionEdge[]
} {
  const edges = projection.edges.filter(edge => edge.kind === 'parent')
  const children = new Set(edges.map(edge => edge.targetId))
  const roots = projection.assets.filter(asset => !children.has(asset.id)).map(asset => asset.id)
  const depth = depthsOf(roots, edges)
  const nodes = stackByDepth(projection.assets, depth, 292, 132)
  return { nodes, edges }
}
