/**
 * ExploreView: the 探索链路 sub-tab of the 代码审计 view. Renders the audit
 * chain (engagement → intent → evidence → derived intent → finding) as an
 * interactive graph with @xyflow/react; positions come from the pure
 * `layoutExploration` helper. `supports` edges are drawn too, so a finding's
 * evidence chain (entry → … → sink → finding) is visible inline. Nodes carry
 * kind/severity/status badges and connection handles, a custom edge renders a
 * visible relationship pill on every chain edge (意图链 / 产出 / 推导自 / 证实 /
 * 支撑), and clicking a node opens the detail drawer — including the frozen
 * code snippet recorded with the evidence or finding.
 */

import { useMemo, useState } from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type EdgeProps,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type {
  CodeauditEdgeKind,
  CodeauditProjection,
  CodeauditSeverity,
} from '../../../dsh-codeaudit/src/client.ts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  EXPLORE_NODE_SIZE,
  findingChainIds,
  layoutExploration,
  type ExploreGraphNode,
  type LayoutOrientation,
} from './graph.ts'
import { GraphDetailDrawer } from './GraphDetailDrawer.tsx'
import type { CodeauditKey } from './locales.ts'
import css from './ExploreView.module.css'

/** Kind badge label keys per node kind. */
const KIND_LABELS: Record<ExploreGraphNode['kind'], CodeauditKey> = {
  engagement: 'kind.engagement',
  intent: 'kind.intent',
  evidence: 'kind.evidence',
  finding: 'kind.finding',
}

/** Relationship label keys per chain edge kind (parent edges never reach this view). */
const EDGE_LABELS: Record<CodeauditEdgeKind, CodeauditKey> = {
  spawns: 'edge.spawns',
  yields: 'edge.yields',
  derived_from: 'edge.derived_from',
  proves: 'edge.proves',
  supports: 'edge.supports',
  parent: 'edge.parent',
}

/** Severity badge label keys. */
const SEVERITY_LABELS: Record<CodeauditSeverity, CodeauditKey> = {
  critical: 'severity.critical',
  high: 'severity.high',
  medium: 'severity.medium',
  low: 'severity.low',
  info: 'severity.info',
}

/** The React Flow node payload of one placed chain node (type alias: the node data must satisfy Record<string, unknown>). */
type FlowNodeData = { readonly node: ExploreGraphNode }

/** One custom flow node: a kind badge over the title and detail line, with source/target handles. */
function ChainNode({ data, t }: NodeProps & { t: PropsLocale<'codeaudit'>['t'] }) {
  const node = (data as FlowNodeData).node
  return (
    <div className={css.node} data-kind={node.kind} data-severity={node.severity} data-testid={`explore-node-${node.kind}`}>
      <Handle type="target" position={Position.Left} className={css.handle} />
      <span className={css.badge}>{t(KIND_LABELS[node.kind])}</span>
      <span className={css.title} title={node.title}>{node.title}</span>
      {node.detail !== '' && <span className={css.detail} title={node.detail}>{node.detail}</span>}
      {node.severity !== undefined && (
        <span className={css.severity} data-severity={node.severity}>{t(SEVERITY_LABELS[node.severity])}</span>
      )}
      {node.status !== undefined && (
        <span className={css.status} data-status={node.status}>{t(node.status === 'confirmed' ? 'status.confirmed' : 'status.suspected')}</span>
      )}
      <Handle type="source" position={Position.Right} className={css.handle} />
    </div>
  )
}

/** One custom edge: a bezier curve with a visible relationship pill at its midpoint. */
export function ChainEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetPosition, targetX, targetY })
  return (
    <>
      <BaseEdge id={id} path={path} />
      {label !== undefined && (
        <EdgeLabelRenderer>
          <div className={css.edgeLabel} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/** Full props of the explore sub-tab. */
export interface ExploreViewProps {
  readonly codeaudit: CodeauditProjection
  readonly t: PropsLocale<'codeaudit'>['t']
}

/** The two chain filters: everything, or only paths that ended at a finding. */
type ChainFilter = 'all' | 'findings'

/** The two reading directions of the layered layout. */
type LayoutMode = LayoutOrientation

/** One toolbar toggle: a pair of mutually-exclusive options. */
function Toggle({
  options,
  value,
  onChange,
  testId,
}: {
  readonly options: ReadonlyArray<{ readonly key: string; readonly label: string; readonly testId: string }>
  readonly value: string
  readonly onChange: (key: string) => void
  readonly testId: string
}) {
  return (
    <div className={css.toggle} data-testid={testId}>
      {options.map(option => (
        <button
          key={option.key}
          type="button"
          className={css.toggleButton}
          aria-pressed={value === option.key}
          data-testid={option.testId}
          onClick={() => { onChange(option.key) }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function ExploreView({ codeaudit, t }: ExploreViewProps) {
  const [filter, setFilter] = useState<ChainFilter>('all')
  const [layout, setLayout] = useState<LayoutMode>('horizontal')
  const [selectedNode, setSelectedNode] = useState<ExploreGraphNode | null>(null)
  // The 仅漏洞链路 filter keeps the nodes on any path ending at a finding and
  // drops dead-end exploration branches, so a long audit stays readable.
  const chainIds = useMemo(() => filter === 'findings' ? findingChainIds(codeaudit) : undefined, [codeaudit, filter])
  const scoped = useMemo(() => chainIds === undefined ? codeaudit : {
    ...codeaudit,
    nodes: codeaudit.nodes.filter(node => chainIds.has(node.id)),
    edges: codeaudit.edges.filter(edge => chainIds.has(edge.sourceId) && chainIds.has(edge.targetId)),
  }, [codeaudit, chainIds])
  const { nodes, edges } = useMemo(() => layoutExploration(scoped, { orientation: layout }), [scoped, layout])
  const flowNodes = useMemo<FlowNode<FlowNodeData, 'codeaudit'>[]>(() =>
    nodes.map(node => ({
      id: node.id,
      type: 'codeaudit',
      position: { x: node.x, y: node.y },
      data: { node },
      style: EXPLORE_NODE_SIZE,
    })), [nodes])
  const flowEdges = useMemo<FlowEdge[]>(() =>
    edges.map(edge => ({
      id: edge.id,
      type: 'codeaudit',
      source: edge.sourceId,
      target: edge.targetId,
      label: t(EDGE_LABELS[edge.kind]),
    })), [edges, t])
  // The locale seat rides into the custom nodes through a render-scoped type
  // map (React Flow re-renders nodes when the map identity changes).
  const nodeTypes = useMemo<NodeTypes>(() => ({
    codeaudit: (props: NodeProps) => <ChainNode {...props} t={t} />,
  }), [t])
  const filterOptions = [
    { key: 'all', label: t('explore.mode.all'), testId: 'codeaudit-explore-filter-all' },
    { key: 'findings', label: t('explore.mode.findings'), testId: 'codeaudit-explore-filter-findings' },
  ] as const
  const layoutOptions = [
    { key: 'horizontal', label: t('explore.layout.horizontal'), testId: 'codeaudit-explore-layout-horizontal' },
    { key: 'vertical', label: t('explore.layout.vertical'), testId: 'codeaudit-explore-layout-vertical' },
  ] as const
  const emptyNote = filter === 'findings' && codeaudit.nodes.some(node => node.kind !== 'finding')
    ? t('explore.noFindings')
    : t('explore.empty')
  return (
    <div className={css.root} data-testid="codeaudit-explore">
      <div className={css.toolbar} data-testid="codeaudit-explore-toolbar">
        <Toggle options={filterOptions} value={filter} onChange={key => { setFilter(key as ChainFilter) }} testId="codeaudit-explore-filter" />
        <Toggle options={layoutOptions} value={layout} onChange={key => { setLayout(key as LayoutMode) }} testId="codeaudit-explore-layout" />
      </div>
      <div className={css.graph}>
        {nodes.length <= 1 ? (
          <p className={css.empty} data-testid="codeaudit-explore-empty">{emptyNote}</p>
        ) : (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={{ codeaudit: ChainEdge }}
            // A wide zoom range: fitView can shrink a long chain to a
            // one-screen overview while the minimap keeps orientation, and
            // zooming in reaches readable card text.
            minZoom={0.05}
            maxZoom={4}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, flowNode) => { setSelectedNode((flowNode.data as FlowNodeData).node) }}
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className={css.minimap} data-testid="codeaudit-explore-minimap" />
          </ReactFlow>
        )}
      </div>
      {selectedNode !== null && (
        <GraphDetailDrawer
          title={selectedNode.title}
          fields={[
            { label: '类型', value: t(KIND_LABELS[selectedNode.kind]) },
            { label: '说明', value: selectedNode.detail },
            ...(selectedNode.location === '' ? [] : [{ label: '代码位置', value: selectedNode.location, mono: true }]),
            ...(selectedNode.snippet === '' ? [] : [{ label: '代码片段', value: selectedNode.snippet, mono: true }]),
            ...(selectedNode.severity === undefined ? [] : [{ label: '风险等级', value: t(SEVERITY_LABELS[selectedNode.severity]) }]),
            ...(selectedNode.status === undefined ? [] : [{ label: '状态', value: t(selectedNode.status === 'confirmed' ? 'status.confirmed' : 'status.suspected') }]),
          ]}
          onClose={() => { setSelectedNode(null) }}
        />
      )}
    </div>
  )
}
