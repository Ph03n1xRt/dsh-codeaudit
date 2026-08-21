/**
 * Pure graph-layout acceptance: `layoutExploration` (BFS layers from the
 * engagement over chain edges only — supports edges included, so a finding's
 * evidence chain draws inline) and `layoutAssets` (parent-tree layers)
 * produce the expected columns, stacking, and edge filtering.
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { CodeauditProjection } from '../../dsh-codeaudit/src/client.ts'
import { findingChainIds, layoutAssets, layoutExploration } from '../src/client/graph.ts'

/** A chain projection: engagement → intent → entry evidence → derived intent → sink evidence → finding. */
function chainProjection(): CodeauditProjection {
  return {
    engagement: { id: 'engagement-1', target: 'shop-backend', objective: 'audit injection', scope: '', stack: 'Java/Spring' },
    nodes: [
      { id: 'intent-1', kind: 'intent', title: 'trace order', detail: 'source → sink' },
      { id: 'evidence-1', kind: 'evidence', evidenceKind: 'entry', intentId: 'intent-1', location: 'src/OrderController.java:42', detail: 'q reaches DAO', snippet: 'find(@RequestParam String q)', confidence: 0.9 },
      { id: 'intent-2', kind: 'intent', title: 'trace OrderDao', detail: '' },
      { id: 'evidence-2', kind: 'evidence', evidenceKind: 'sink', intentId: 'intent-2', location: 'src/OrderDao.java:87', detail: 'concatenation', snippet: '', confidence: 0.5 },
      { id: 'finding-1', kind: 'finding', intentId: 'intent-2', title: 'sqli', severity: 'high', status: 'confirmed', cwe: 'CWE-89', description: 'injectable', location: 'src/OrderDao.java:87', snippet: '', fix: '', evidenceIds: ['evidence-2'], affectedAssetId: undefined },
    ],
    assets: [
      { id: 'asset-1', type: 'repo', value: 'shop-backend', meta: '' },
      { id: 'asset-2', type: 'module', value: 'order-service', meta: '' },
    ],
    edges: [
      { id: 'edge-1', kind: 'spawns', sourceId: 'engagement-1', targetId: 'intent-1' },
      { id: 'edge-2', kind: 'yields', sourceId: 'intent-1', targetId: 'evidence-1' },
      { id: 'edge-3', kind: 'derived_from', sourceId: 'evidence-1', targetId: 'intent-2' },
      { id: 'edge-4', kind: 'yields', sourceId: 'intent-2', targetId: 'evidence-2' },
      { id: 'edge-5', kind: 'proves', sourceId: 'intent-2', targetId: 'finding-1' },
      { id: 'edge-6', kind: 'supports', sourceId: 'evidence-2', targetId: 'finding-1' },
      { id: 'edge-7', kind: 'parent', sourceId: 'asset-1', targetId: 'asset-2' },
    ],
    counts: { intents: 2, evidences: 2, findings: 1, assets: 2 },
  }
}

describe('layoutExploration', () => {
  it('lays a pure chain one column per hop with supports edges drawn inline', () => {
    const { nodes, edges } = layoutExploration(chainProjection())
    expect(edges.map(edge => edge.kind)).toEqual(['spawns', 'yields', 'derived_from', 'yields', 'proves', 'supports'])
    const byId = new Map(nodes.map(node => [node.id, node]))
    expect(byId.get('engagement-1')).toMatchObject({ kind: 'engagement', title: 'shop-backend', x: 0, y: 0 })
    expect(byId.get('intent-1')).toMatchObject({ kind: 'intent', title: 'trace order', detail: 'source → sink', x: 320, y: 0 })
    expect(byId.get('evidence-1')).toMatchObject({ kind: 'evidence', title: 'q reaches DAO', detail: 'src/OrderController.java:42 [entry] · 0.9', location: 'src/OrderController.java:42', snippet: 'find(@RequestParam String q)', x: 640, y: 0 })
    expect(byId.get('intent-2')).toMatchObject({ kind: 'intent', x: 960, y: 0 })
    // The supports edge pulls the finding into the sink evidence's column:
    // entry(2) → derived intent(3) → sink evidence(4) ≈ finding(4), stacked.
    expect(byId.get('evidence-2')).toMatchObject({ kind: 'evidence', x: 1280, y: 0 })
    expect(byId.get('finding-1')).toMatchObject({ kind: 'finding', severity: 'high', status: 'confirmed', title: 'sqli', location: 'src/OrderDao.java:87', x: 1280, y: 152 })
  })

  it('stacks sibling nodes of one layer vertically and excludes parent edges', () => {
    const projection: CodeauditProjection = {
      ...chainProjection(),
      nodes: [
        ...chainProjection().nodes,
        { id: 'intent-3', kind: 'intent', title: 'second intent', detail: '' },
        { id: 'evidence-3', kind: 'evidence', evidenceKind: 'sanitizer', intentId: 'intent-1', location: '', detail: 'framework escaper present', snippet: '', confidence: 0.5 },
      ],
      edges: [
        ...chainProjection().edges,
        { id: 'edge-8', kind: 'spawns', sourceId: 'engagement-1', targetId: 'intent-3' },
        { id: 'edge-9', kind: 'yields', sourceId: 'intent-1', targetId: 'evidence-3' },
      ],
    }
    const { nodes, edges } = layoutExploration(projection)
    expect(edges.some(edge => edge.kind === 'parent')).toBe(false)
    const layerOne = nodes.filter(node => node.x === 320).sort((a, b) => a.y - b.y)
    expect(layerOne.map(node => node.id)).toEqual(['intent-1', 'intent-3'])
    expect(layerOne[0]!.y).toBe(0)
    expect(layerOne[1]!.y).toBe(152)
    // A location-less evidence renders its detail without the location prefix.
    expect(nodes.find(node => node.id === 'evidence-3')).toMatchObject({ detail: '[sanitizer] · 0.5' })
  })

  it('hangs nodes unreachable from the engagement in the last column and tolerates a missing engagement', () => {
    const projection: CodeauditProjection = {
      ...chainProjection(),
      nodes: [
        ...chainProjection().nodes,
        { id: 'finding-9', kind: 'finding', intentId: 'intent-9', title: 'orphan', severity: 'low', status: 'suspected', cwe: '', description: '', location: 'a:1', snippet: '', fix: '', evidenceIds: ['evidence-9'], affectedAssetId: undefined },
      ],
    }
    const { nodes } = layoutExploration(projection)
    const orphan = nodes.find(node => node.id === 'finding-9')!
    expect(orphan.x).toBeGreaterThan(1280) // one column past the deepest chain column
    // A null engagement still yields an engagement start node with empty text.
    const engagementless = layoutExploration({ ...projection, engagement: null })
    expect(engagementless.nodes[0]).toMatchObject({ id: 'engagement-1', kind: 'engagement', title: '', x: 0, y: 0 })
  })

  it('places depth on the y axis in vertical mode, siblings side by side', () => {
    const { nodes } = layoutExploration(chainProjection(), { orientation: 'vertical' })
    const byId = new Map(nodes.map(node => [node.id, node]))
    expect(byId.get('engagement-1')).toMatchObject({ x: 0, y: 0 })
    expect(byId.get('intent-1')).toMatchObject({ x: 0, y: 320 })
    expect(byId.get('evidence-1')).toMatchObject({ x: 0, y: 640 })
    expect(byId.get('intent-2')).toMatchObject({ x: 0, y: 960 })
    // The sink evidence and the finding share a depth level: stacked horizontally now.
    expect(byId.get('evidence-2')).toMatchObject({ x: 0, y: 1280 })
    expect(byId.get('finding-1')).toMatchObject({ x: 152, y: 1280 })
  })
})

describe('findingChainIds', () => {
  it('keeps only the nodes on paths ending at a finding, including the engagement root', () => {
    // intent-3 is a dead-end exploration branch (no finding downstream).
    const projection: CodeauditProjection = {
      ...chainProjection(),
      nodes: [
        ...chainProjection().nodes,
        { id: 'intent-3', kind: 'intent', title: 'dead end', detail: '' },
      ],
      edges: [
        ...chainProjection().edges,
        { id: 'edge-8', kind: 'spawns', sourceId: 'engagement-1', targetId: 'intent-3' },
      ],
    }
    const keep = findingChainIds(projection)
    expect([...keep].sort()).toEqual(['engagement-1', 'evidence-1', 'evidence-2', 'finding-1', 'intent-1', 'intent-2'])
    expect(keep.has('intent-3')).toBe(false)
  })

  it('is empty before any finding exists', () => {
    const projection: CodeauditProjection = {
      ...chainProjection(),
      nodes: chainProjection().nodes.filter(node => node.kind !== 'finding'),
    }
    expect(findingChainIds(projection).size).toBe(0)
  })
})

describe('layoutAssets', () => {
  it('lays the asset tree out from roots one column per parent hop', () => {
    const projection: CodeauditProjection = {
      engagement: { id: 'engagement-1', target: 'shop-backend', objective: 'o', scope: '', stack: '' },
      nodes: [],
      assets: [
        { id: 'asset-1', type: 'repo', value: 'shop-backend', meta: '' },
        { id: 'asset-2', type: 'module', value: 'order-service', meta: '' },
        { id: 'asset-3', type: 'file', value: 'src/OrderDao.java', meta: '' },
        { id: 'asset-4', type: 'function', value: 'OrderDao.findByUser', meta: '' },
      ],
      edges: [
        { id: 'edge-1', kind: 'parent', sourceId: 'asset-1', targetId: 'asset-2' },
        { id: 'edge-2', kind: 'parent', sourceId: 'asset-1', targetId: 'asset-3' },
        { id: 'edge-3', kind: 'parent', sourceId: 'asset-3', targetId: 'asset-4' },
      ],
      counts: { intents: 0, evidences: 0, findings: 0, assets: 4 },
    }
    const { nodes, edges } = layoutAssets(projection)
    expect(edges).toEqual(projection.edges)
    const byId = new Map(nodes.map(node => [node.id, node]))
    expect(byId.get('asset-1')).toMatchObject({ x: 0, y: 0 })
    expect(byId.get('asset-2')).toMatchObject({ x: 292, y: 0 })
    expect(byId.get('asset-3')).toMatchObject({ x: 292, y: 132 })
    expect(byId.get('asset-4')).toMatchObject({ x: 584, y: 0 })
  })

  it('treats assets without parent edges as roots', () => {
    const projection: CodeauditProjection = {
      engagement: { id: 'engagement-1', target: 'shop-backend', objective: 'o', scope: '', stack: '' },
      nodes: [],
      assets: [
        { id: 'asset-1', type: 'config', value: 'application.yaml', meta: '' },
        { id: 'asset-2', type: 'config', value: 'prod.yaml', meta: '' },
      ],
      edges: [],
      counts: { intents: 0, evidences: 0, findings: 0, assets: 2 },
    }
    const { nodes } = layoutAssets(projection)
    expect(nodes.map(node => [node.id, node.x, node.y])).toEqual([
      ['asset-1', 0, 0],
      ['asset-2', 0, 132],
    ])
  })
})
