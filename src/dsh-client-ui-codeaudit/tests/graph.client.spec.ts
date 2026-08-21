/**
 * Pure graph-layout acceptance: `buildExploreModel` (the aggregated,
 * expandable model — collapsed evidences, remapped edges, per-intent counts),
 * `layoutExploration` (BFS depth layers over the model, supports edges drawn
 * inline, axes swappable), `findingChainIds` (the 仅漏洞链路 filter), and
 * `layoutAssets` (parent-tree layers).
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { CodeauditProjection } from '../../dsh-codeaudit/src/client.ts'
import { AUTO_EXPAND_MAX_NODES, buildExploreModel, findingChainIds, layoutAssets, layoutExploration } from '../src/client/graph.ts'

/** A chain projection: engagement → intent → entry evidence → derived intent → sink evidence → finding. */
function chainProjection(): CodeauditProjection {
  return {
    engagement: { id: 'engagement-1', target: 'shop-backend', objective: 'audit injection', scope: '', stack: 'Java/Spring' },
    nodes: [
      { id: 'intent-1', kind: 'intent', title: 'trace order', detail: 'source → sink' },
      { id: 'evidence-1', kind: 'evidence', evidenceKind: 'entry', intentId: 'intent-1', location: 'src/OrderController.java:42', detail: 'q reaches DAO', snippet: 'find(@RequestParam String q)', confidence: 0.9 },
      { id: 'intent-2', kind: 'intent', title: 'trace OrderDao', detail: '' },
      { id: 'evidence-2', kind: 'evidence', evidenceKind: 'sink', intentId: 'intent-2', location: 'src/OrderDao.java:87', detail: 'concatenation', snippet: '', confidence: 0.5 },
      { id: 'finding-1', kind: 'finding', intentId: 'intent-2', title: 'sqli', severity: 'high', status: 'confirmed', cwe: 'CWE-89', description: 'injectable', location: 'src/OrderDao.java:87', snippet: '', poc: '', pocNote: '', pocScript: '', fix: '', evidenceIds: ['evidence-2'], affectedAssetId: undefined },
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

/** The id set expanding every intent of one projection. */
function allExpanded(projection: CodeauditProjection): Set<string> {
  return new Set(projection.nodes
    .filter((node): node is Extract<CodeauditProjection['nodes'][number], { kind: 'intent' }> => node.kind === 'intent')
    .map(node => node.id))
}

describe('buildExploreModel', () => {
  it('collapsed: hides the evidences, remaps their edges to the owning intent, and reports counts', () => {
    const model = buildExploreModel(chainProjection(), new Set())
    // Only the skeleton is visible: intents + findings, no evidences.
    expect(model.nodes.map(node => node.id)).toEqual(['intent-1', 'intent-2', 'finding-1'])
    // yields absorbed; derived_from/supports re-anchored on the owning intent;
    // the parent edge belongs to the asset graph and drops.
    expect(model.edges).toEqual([
      { id: 'edge-1', kind: 'spawns', sourceId: 'engagement-1', targetId: 'intent-1' },
      { id: 'edge-3', kind: 'derived_from', sourceId: 'intent-1', targetId: 'intent-2' },
      { id: 'edge-5', kind: 'proves', sourceId: 'intent-2', targetId: 'finding-1' },
      { id: 'edge-6', kind: 'supports', sourceId: 'intent-2', targetId: 'finding-1' },
    ])
    expect(model.intentStats.get('intent-1')).toEqual({ evidences: 1, findings: 0 })
    expect(model.intentStats.get('intent-2')).toEqual({ evidences: 1, findings: 1 })
  })

  it('expanded: keeps every evidence and its original edges', () => {
    const model = buildExploreModel(chainProjection(), allExpanded(chainProjection()))
    // The model groups by node kind (intents, then evidences, then findings);
    // the layout sorts by depth afterwards.
    expect(model.nodes.map(node => node.id)).toEqual(['intent-1', 'intent-2', 'evidence-1', 'evidence-2', 'finding-1'])
    expect(model.edges.map(edge => edge.id)).toEqual(['edge-1', 'edge-2', 'edge-3', 'edge-4', 'edge-5', 'edge-6'])
    // Mixed expansion: only the expanded intent's evidence shows.
    const mixed = buildExploreModel(chainProjection(), new Set(['intent-2']))
    expect(mixed.nodes.map(node => node.id)).toEqual(['intent-1', 'intent-2', 'evidence-2', 'finding-1'])
    expect(mixed.edges.map(edge => edge.id)).toEqual(['edge-1', 'edge-3', 'edge-4', 'edge-5', 'edge-6'])
  })

  it('de-duplicates parallel remapped edges', () => {
    const projection: CodeauditProjection = {
      ...chainProjection(),
      nodes: [
        ...chainProjection().nodes,
        { id: 'evidence-3', kind: 'evidence', evidenceKind: 'sanitizer', intentId: 'intent-2', location: '', detail: 'escaper present', snippet: '', confidence: 0.5 },
      ],
      edges: [
        ...chainProjection().edges,
        { id: 'edge-8', kind: 'yields', sourceId: 'intent-2', targetId: 'evidence-3' },
        { id: 'edge-9', kind: 'supports', sourceId: 'evidence-3', targetId: 'finding-1' },
      ],
    }
    const model = buildExploreModel(projection, new Set())
    // evidence-2 and evidence-3 both support finding-1: one remapped
    // intent-2→finding-1 supports edge survives.
    const supports = model.edges.filter(edge => edge.kind === 'supports')
    expect(supports).toEqual([{ id: 'edge-6', kind: 'supports', sourceId: 'intent-2', targetId: 'finding-1' }])
  })
})

describe('layoutExploration', () => {
  it('grows one lane per intent top-down: evidences then findings below their own intent', () => {
    const { nodes, edges } = layoutExploration(buildExploreModel(chainProjection(), allExpanded(chainProjection())))
    expect(edges.map(edge => edge.kind)).toEqual(['spawns', 'yields', 'derived_from', 'yields', 'proves', 'supports'])
    const byId = new Map(nodes.map(node => [node.id, node]))
    // The engagement centers above the two lanes. laneStep = 236 + 72 = 308.
    expect(byId.get('engagement-1')).toMatchObject({ kind: 'engagement', title: 'shop-backend', x: 190, y: 0 })
    // Lane 0: intent-1 with its evidence directly below it.
    expect(byId.get('intent-1')).toMatchObject({ kind: 'intent', title: 'trace order', detail: 'source → sink', x: 0, y: 192, evidenceCount: 1 })
    expect(byId.get('evidence-1')).toMatchObject({ kind: 'evidence', title: 'q reaches DAO', detail: 'src/OrderController.java:42 [entry] · 0.9', location: 'src/OrderController.java:42', snippet: 'find(@RequestParam String q)', x: 0, y: 384 })
    // Lane 1 (laneStep 308): intent-2, its evidence, and its finding stacked
    // at the bottom of the SAME lane — the hierarchy the user reads.
    expect(byId.get('intent-2')).toMatchObject({ kind: 'intent', x: 308, y: 192, evidenceCount: 1, findingCount: 1 })
    expect(byId.get('evidence-2')).toMatchObject({ kind: 'evidence', x: 308, y: 384 })
    expect(byId.get('finding-1')).toMatchObject({ kind: 'finding', severity: 'high', status: 'confirmed', title: 'sqli', location: 'src/OrderDao.java:87', x: 308, y: 576 })
  })

  it('folds cleanly: a collapsed lane holds the intent with its findings directly below', () => {
    const { nodes } = layoutExploration(buildExploreModel(chainProjection(), new Set()))
    const byId = new Map(nodes.map(node => [node.id, node]))
    expect(byId.get('engagement-1')).toMatchObject({ x: 190, y: 0 })
    expect(byId.get('intent-1')).toMatchObject({ x: 0, y: 192 })
    expect(byId.get('intent-2')).toMatchObject({ x: 308, y: 192 })
    expect(byId.get('finding-1')).toMatchObject({ x: 308, y: 384 })
  })

  it('keeps one intent\'s evidences adjacent in its lane and excludes parent edges', () => {
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
    const { nodes, edges } = layoutExploration(buildExploreModel(projection, allExpanded(projection)))
    expect(edges.some(edge => edge.kind === 'parent')).toBe(false)
    const byId = new Map(nodes.map(node => [node.id, node]))
    // Lane 0 stacks intent-1, evidence-1, evidence-3 (submission order);
    // intent-3 owns lane 2 (x = 616).
    expect(byId.get('intent-1')).toMatchObject({ x: 0, y: 192 })
    expect(byId.get('evidence-1')).toMatchObject({ x: 0, y: 384 })
    expect(byId.get('evidence-3')).toMatchObject({ x: 0, y: 576 })
    expect(byId.get('intent-3')).toMatchObject({ x: 616, y: 192 })
    // A location-less evidence renders its detail without the location prefix.
    expect(byId.get('evidence-3')).toMatchObject({ detail: '[sanitizer] · 0.5' })
  })

  it('places an orphan finding (unknown intent) in a trailing lane and tolerates a missing engagement', () => {
    const projection: CodeauditProjection = {
      ...chainProjection(),
      nodes: [
        ...chainProjection().nodes,
        { id: 'finding-9', kind: 'finding', intentId: 'intent-9', title: 'orphan', severity: 'low', status: 'suspected', cwe: '', description: '', location: 'a:1', snippet: '', poc: '', pocNote: '', pocScript: '', fix: '', evidenceIds: ['evidence-9'], affectedAssetId: undefined },
      ],
    }
    const { nodes } = layoutExploration(buildExploreModel(projection, allExpanded(projection)))
    const orphan = nodes.find(node => node.id === 'finding-9')!
    expect(orphan).toMatchObject({ x: 616, y: 192 }) // the trailing unnamed lane
    // A null engagement still yields an engagement card with empty text.
    const engagementless = layoutExploration(buildExploreModel({ ...projection, engagement: null }, allExpanded(projection)))
    expect(engagementless.nodes[0]).toMatchObject({ id: 'engagement-1', kind: 'engagement', title: '', x: 344, y: 0 })
  })

  it('grows left-to-right in horizontal mode: lanes become rows', () => {
    const { nodes } = layoutExploration(buildExploreModel(chainProjection(), allExpanded(chainProjection())), { orientation: 'horizontal' })
    const byId = new Map(nodes.map(node => [node.id, node]))
    // laneStep = 120 + 72 = 192 on y; within cards start one withinStep
    // (236 + 72 = 308) right of the engagement card.
    expect(byId.get('engagement-1')).toMatchObject({ x: 0, y: 132 })
    expect(byId.get('intent-1')).toMatchObject({ x: 308, y: 0 })
    expect(byId.get('evidence-1')).toMatchObject({ x: 616, y: 0 })
    expect(byId.get('intent-2')).toMatchObject({ x: 308, y: 192 })
    expect(byId.get('evidence-2')).toMatchObject({ x: 616, y: 192 })
    expect(byId.get('finding-1')).toMatchObject({ x: 924, y: 192 })
  })

  it('exposes the auto-expand threshold used by the view', () => {
    expect(AUTO_EXPAND_MAX_NODES).toBeGreaterThan(0)
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
