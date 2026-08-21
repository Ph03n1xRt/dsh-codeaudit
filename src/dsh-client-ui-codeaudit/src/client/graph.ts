/**
 * Pure graph-layout helpers for the codeaudit view tabs: layered positions for
 * the audit chain (engagement → intents → evidences → derived intents →
 * findings, with the finding's `supports` evidence edges drawn inline so each
 * vulnerability's full chain entry → … → sink → finding is visible in one
 * graph) and for the asset tree (parent → children). Pure functions of the
 * standing projection — fully unit-testable, no React Flow involvement.
 */

import type {
  CodeauditProjection,
  CodeauditProjectionEdge,
  CodeauditProjectionNode,
  CodeauditSeverity,
  CodeauditAssetType,
  CodeauditFindingStatus,
} from '../../../dsh-codeaudit/src/client.ts'

/** Node kinds drawn in the audit graph. */
export type ExploreNodeKind = 'engagement' | 'intent' | 'evidence' | 'finding'

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
 * Layered layout of the audit chain: the engagement at column 0, every node
 * one column per hop along its chain edges (supports edges included, so an
 * evidence can sit one hop before its finding); nodes unreachable from the
 * engagement hang in the last column. Parent edges are excluded. The
 * orientation picks the reading direction: horizontal places depth on the
 * x axis (wide), vertical on the y axis (tall — usually the better fit for a
 * narrow side panel carrying a long chain).
 * @param projection - the standing codeaudit projection.
 * @param options - layout options (orientation, default horizontal).
 * @returns the placed nodes and their chain edges.
 */
export function layoutExploration(projection: CodeauditProjection, options: LayoutOptions = {}): {
  nodes: ExploreGraphNode[]
  edges: CodeauditProjectionEdge[]
} {
  const vertical = options.orientation === 'vertical'
  const edges = projection.edges.filter(edge => CHAIN_EDGE_KINDS.has(edge.kind))
  const engagementId = projection.engagement === null ? 'engagement-1' : projection.engagement.id
  const depth = depthsOf([engagementId], edges)
  const engagement: ExploreGraphNode = {
    id: engagementId,
    kind: 'engagement',
    title: projection.engagement === null ? '' : projection.engagement.target,
    detail: projection.engagement === null ? '' : projection.engagement.objective,
    severity: undefined,
    status: undefined,
    location: '',
    snippet: '',
    x: 0,
    y: 0,
  }
  const chain: Array<ExploreGraphNode & { readonly x: number; readonly y: number }> = stackByDepth(
    [engagement, ...projection.nodes.map(node => ({
      id: node.id,
      kind: node.kind,
      title: titleOf(node),
      detail: detailOf(node),
      severity: node.kind === 'finding' ? node.severity : undefined,
      status: node.kind === 'finding' ? node.status : undefined,
      location: locationOf(node),
      snippet: snippetOf(node),
    }))],
    depth,
    320,
    152,
    vertical,
  )
  return { nodes: chain, edges }
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
