/**
 * The standing `codeaudit` projection: the pure fold over logged codeaudit_*
 * tool calls (the audit graph with deterministic ids, including each finding's
 * proves + supports edge set), the wire schema, and the live registration
 * through the session-projection seam (mounted harness, driven by real session
 * events).
 * @module
 */

import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { POC_MAX_CHARS, SNIPPET_MAX_CHARS } from '../src/spec.ts'
import {
  applyCodeauditEvent,
  codeauditInitialState,
  codeauditProjectionSchema,
  viewCodeauditState,
  ASSET_CAP,
  EDGE_CAP,
  NODE_CAP,
} from '../src/projection.ts'
import type { CodeauditFoldState } from '../src/projection.ts'
import { codeauditProjectionHarness } from './harness.ts'

/** One tool/call event carrying the given codeaudit tool name and raw JSON arguments. */
function toolCall(name: string, args: string, seq = 1, callId = 'c1'): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: seq,
    data: { turn: 1, step: 1, callId: CallId(callId), name, arguments: args },
  }
}

/** Fold a sequence of tool calls from the initial state. */
function fold(...events: SessionEvent[]): CodeauditFoldState {
  return events.reduce(applyCodeauditEvent, codeauditInitialState)
}

/** The canonical full chain: engagement → spawns intent → entry evidence → derived intent → sink evidence → finding. */
function fullChainEvents(): SessionEvent[] {
  return [
    toolCall('codeaudit_set_engagement', '{"target":"shop-backend","objective":"audit injection","scope":"src/main","stack":"Java/Spring"}', 1, 'e1'),
    toolCall('codeaudit_add_intent', '{"engagementId":"engagement-1","title":"trace order params","detail":"source → sink"}', 2, 'i1'),
    toolCall('codeaudit_add_evidence', '{"intentId":"intent-1","kind":"entry","location":"src/OrderController.java:42","detail":"q reaches DAO","snippet":"find(@RequestParam String q)","confidence":0.9}', 3, 'v1'),
    toolCall('codeaudit_add_intent', '{"derivedFromEvidenceId":"evidence-1","title":"trace OrderDao sink"}', 4, 'i2'),
    toolCall('codeaudit_add_evidence', '{"intentId":"intent-2","kind":"sink","location":"src/OrderDao.java:87","detail":"string concatenation","snippet":"jdbc.query(\\"...\\" + q)"}', 5, 'v2'),
    toolCall('codeaudit_add_finding', '{"intentId":"intent-2","title":"sqli","severity":"high","status":"confirmed","cwe":"CWE-89","description":"injectable","location":"src/OrderDao.java:87","fix":"parameterize","evidenceIds":["evidence-2"]}', 6, 'n1'),
  ]
}

describe('applyCodeauditEvent', () => {
  it('codeaudit_set_engagement resets to a fresh graph with the engagement', () => {
    const state = fold(...fullChainEvents())
    const reset = applyCodeauditEvent(state, toolCall('codeaudit_set_engagement', '{"target":"other","objective":"fresh"}', 7, 'e2'))
    expect(reset).toEqual({
      engagement: { id: 'engagement-1', target: 'other', objective: 'fresh', scope: '', stack: '' },
      nodes: [],
      assets: [],
      edges: [],
      counters: { intent: 0, evidence: 0, finding: 0, asset: 0, edge: 0 },
    })
  })

  it('skips an engagement without target or objective', () => {
    const before = fold(...fullChainEvents())
    expect(applyCodeauditEvent(before, toolCall('codeaudit_set_engagement', '{"target":""}', 7, 'e2'))).toBe(before)
    expect(applyCodeauditEvent(before, toolCall('codeaudit_set_engagement', '{"objective":"o"}', 7, 'e2'))).toBe(before)
  })

  it('folds the full chain with deterministic ids, snippets, and the supports edge set', () => {
    const state = fold(...fullChainEvents())
    expect(state.engagement).toEqual({ id: 'engagement-1', target: 'shop-backend', objective: 'audit injection', scope: 'src/main', stack: 'Java/Spring' })
    expect(state.nodes).toEqual([
      { id: 'intent-1', kind: 'intent', title: 'trace order params', detail: 'source → sink' },
      { id: 'evidence-1', kind: 'evidence', evidenceKind: 'entry', intentId: 'intent-1', location: 'src/OrderController.java:42', detail: 'q reaches DAO', snippet: 'find(@RequestParam String q)', confidence: 0.9 },
      { id: 'intent-2', kind: 'intent', title: 'trace OrderDao sink', detail: '' },
      { id: 'evidence-2', kind: 'evidence', evidenceKind: 'sink', intentId: 'intent-2', location: 'src/OrderDao.java:87', detail: 'string concatenation', snippet: 'jdbc.query("..." + q)', confidence: 0.5 },
      { id: 'finding-1', kind: 'finding', intentId: 'intent-2', title: 'sqli', severity: 'high', status: 'confirmed', cwe: 'CWE-89', description: 'injectable', location: 'src/OrderDao.java:87', snippet: '', poc: '', pocNote: '', pocScript: '', fix: 'parameterize', evidenceIds: ['evidence-2'], affectedAssetId: undefined },
    ])
    expect(state.edges).toEqual([
      { id: 'edge-1', kind: 'spawns', sourceId: 'engagement-1', targetId: 'intent-1' },
      { id: 'edge-2', kind: 'yields', sourceId: 'intent-1', targetId: 'evidence-1' },
      { id: 'edge-3', kind: 'derived_from', sourceId: 'evidence-1', targetId: 'intent-2' },
      { id: 'edge-4', kind: 'yields', sourceId: 'intent-2', targetId: 'evidence-2' },
      { id: 'edge-5', kind: 'proves', sourceId: 'intent-2', targetId: 'finding-1' },
      { id: 'edge-6', kind: 'supports', sourceId: 'evidence-2', targetId: 'finding-1' },
    ])
  })

  it('add_intent requires exactly one resolvable anchor', () => {
    const engagement = toolCall('codeaudit_set_engagement', '{"target":"t","objective":"o"}', 1, 'e1')
    const afterEngagement = fold(engagement)
    const unchanged = fold(engagement)
    const emptyTitle = applyCodeauditEvent(unchanged, toolCall('codeaudit_add_intent', '{"title":"","engagementId":"engagement-1"}', 2, 'i1'))
    const noAnchor = applyCodeauditEvent(emptyTitle, toolCall('codeaudit_add_intent', '{"title":"x"}', 2, 'i1'))
    const both = applyCodeauditEvent(noAnchor, toolCall('codeaudit_add_intent', '{"title":"x","engagementId":"engagement-1","derivedFromEvidenceId":"evidence-1"}', 2, 'i1'))
    const badEngagement = applyCodeauditEvent(both, toolCall('codeaudit_add_intent', '{"title":"x","engagementId":"engagement-9"}', 2, 'i1'))
    expect(emptyTitle).toBe(unchanged)
    expect(noAnchor).toBe(unchanged)
    expect(both).toBe(unchanged)
    expect(badEngagement).toBe(unchanged)
    const badEvidence = applyCodeauditEvent(afterEngagement, toolCall('codeaudit_add_intent', '{"title":"x","derivedFromEvidenceId":"evidence-9"}', 2, 'i1'))
    expect(badEvidence).toBe(afterEngagement)
  })

  it('add_evidence yields evidences with defaults and skips unknown intents or empty details', () => {
    const state = fold(
      toolCall('codeaudit_set_engagement', '{"target":"t","objective":"o"}', 1, 'e1'),
      toolCall('codeaudit_add_intent', '{"engagementId":"engagement-1","title":"a"}', 2, 'i1'),
    )
    const first = applyCodeauditEvent(state, toolCall('codeaudit_add_evidence', '{"intentId":"intent-1","detail":"bare"}', 3, 'v1'))
    expect(first.nodes).toEqual([
      { id: 'intent-1', kind: 'intent', title: 'a', detail: '' },
      { id: 'evidence-1', kind: 'evidence', evidenceKind: 'info', intentId: 'intent-1', location: '', detail: 'bare', snippet: '', confidence: 0.5 },
    ])
    expect(first.edges.at(-1)).toEqual({ id: 'edge-2', kind: 'yields', sourceId: 'intent-1', targetId: 'evidence-1' })
    const unknownIntent = applyCodeauditEvent(state, toolCall('codeaudit_add_evidence', '{"intentId":"intent-9","detail":"x"}', 3, 'v1'))
    expect(unknownIntent).toBe(state)
    const normalized = applyCodeauditEvent(state, toolCall('codeaudit_add_evidence', '{"intentId":"intent-1","kind":"weird","location":"a.java:1","detail":"d","confidence":9}', 3, 'v1'))
    expect(normalized.nodes.at(-1)).toMatchObject({ kind: 'evidence', evidenceKind: 'info', confidence: 0.09 })
    const emptyDetail = applyCodeauditEvent(state, toolCall('codeaudit_add_evidence', '{"intentId":"intent-1","detail":""}', 3, 'v1'))
    expect(emptyDetail).toBe(state)
  })

  it('caps folded snippets at the durable limit, mirroring the tools', () => {
    const state = fold(
      toolCall('codeaudit_set_engagement', '{"target":"t","objective":"o"}', 1, 'e1'),
      toolCall('codeaudit_add_intent', '{"engagementId":"engagement-1","title":"a"}', 2, 'i1'),
    )
    const long = 'y'.repeat(SNIPPET_MAX_CHARS + 25)
    const capped = applyCodeauditEvent(state, toolCall('codeaudit_add_evidence', `{"intentId":"intent-1","detail":"d","snippet":"${long}"}`, 3, 'v1'))
    expect(capped.nodes.at(-1)).toMatchObject({ kind: 'evidence', snippet: 'y'.repeat(SNIPPET_MAX_CHARS) })
  })

  it('add_finding folds proves first, then supports in evidenceIds order', () => {
    const state = fold(
      toolCall('codeaudit_set_engagement', '{"target":"t","objective":"o"}', 1, 'e1'),
      toolCall('codeaudit_add_intent', '{"engagementId":"engagement-1","title":"a"}', 2, 'i1'),
      toolCall('codeaudit_add_evidence', '{"intentId":"intent-1","detail":"entry"}', 3, 'v1'),
      toolCall('codeaudit_add_evidence', '{"intentId":"intent-1","detail":"sink"}', 4, 'v2'),
      toolCall('codeaudit_add_asset', '{"type":"endpoint","value":"/x"}', 5, 'a1'),
    )
    const finding = applyCodeauditEvent(state, toolCall('codeaudit_add_finding', '{"intentId":"intent-1","title":"n","severity":"weird","status":"weird","description":"d","location":"a.java:9","fix":"","cwe":"","evidenceIds":["evidence-2","evidence-1"],"affectedAssetId":"asset-1"}', 6, 'n1'))
    expect(finding.nodes.at(-1)).toMatchObject({
      kind: 'finding', title: 'n', severity: 'info', status: 'suspected', location: 'a.java:9',
      evidenceIds: ['evidence-2', 'evidence-1'], affectedAssetId: 'asset-1',
    })
    expect(finding.edges.slice(-3)).toEqual([
      { id: 'edge-4', kind: 'proves', sourceId: 'intent-1', targetId: 'finding-1' },
      { id: 'edge-5', kind: 'supports', sourceId: 'evidence-2', targetId: 'finding-1' },
      { id: 'edge-6', kind: 'supports', sourceId: 'evidence-1', targetId: 'finding-1' },
    ])
  })

  it('add_finding skips chain-less, location-less, or unresolvable findings', () => {
    const state = fold(
      toolCall('codeaudit_set_engagement', '{"target":"t","objective":"o"}', 1, 'e1'),
      toolCall('codeaudit_add_intent', '{"engagementId":"engagement-1","title":"a"}', 2, 'i1'),
      toolCall('codeaudit_add_evidence', '{"intentId":"intent-1","detail":"sink"}', 3, 'v1'),
    )
    const unknownIntent = applyCodeauditEvent(state, toolCall('codeaudit_add_finding', '{"intentId":"intent-9","title":"n","location":"a:1","evidenceIds":["evidence-1"]}', 4, 'n1'))
    expect(unknownIntent).toBe(state)
    const emptyTitle = applyCodeauditEvent(state, toolCall('codeaudit_add_finding', '{"intentId":"intent-1","title":"","location":"a:1","evidenceIds":["evidence-1"]}', 4, 'n1'))
    expect(emptyTitle).toBe(state)
    const noLocation = applyCodeauditEvent(state, toolCall('codeaudit_add_finding', '{"intentId":"intent-1","title":"n","evidenceIds":["evidence-1"]}', 4, 'n1'))
    expect(noLocation).toBe(state)
    const noChain = applyCodeauditEvent(state, toolCall('codeaudit_add_finding', '{"intentId":"intent-1","title":"n","location":"a:1","evidenceIds":[]}', 4, 'n1'))
    expect(noChain).toBe(state)
    const blankChain = applyCodeauditEvent(state, toolCall('codeaudit_add_finding', '{"intentId":"intent-1","title":"n","location":"a:1","evidenceIds":[""]}', 4, 'n1'))
    expect(blankChain).toBe(state)
    const unknownEvidence = applyCodeauditEvent(state, toolCall('codeaudit_add_finding', '{"intentId":"intent-1","title":"n","location":"a:1","evidenceIds":["evidence-9"]}', 4, 'n1'))
    expect(unknownEvidence).toBe(state)
    const badAsset = applyCodeauditEvent(state, toolCall('codeaudit_add_finding', '{"intentId":"intent-1","title":"n","location":"a:1","evidenceIds":["evidence-1"],"affectedAssetId":"asset-9"}', 4, 'n1'))
    expect(badAsset).toBe(state)
  })

  it('folds the finding poc with the durable cap, mirroring the tools', () => {
    const state = fold(
      toolCall('codeaudit_set_engagement', '{"target":"t","objective":"o"}', 1, 'e1'),
      toolCall('codeaudit_add_intent', '{"engagementId":"engagement-1","title":"a"}', 2, 'i1'),
      toolCall('codeaudit_add_evidence', '{"intentId":"intent-1","detail":"sink"}', 3, 'v1'),
    )
    const poc = 'z'.repeat(POC_MAX_CHARS + 30)
    const folded = applyCodeauditEvent(state, toolCall('codeaudit_add_finding', JSON.stringify({ intentId: 'intent-1', title: 'n', severity: 'high', status: 'confirmed', location: 'a:1', evidenceIds: ['evidence-1'], poc }), 4, 'n1'))
    expect(folded.nodes.at(-1)).toMatchObject({ kind: 'finding', poc: 'z'.repeat(POC_MAX_CHARS) })
  })

  it('add_asset records root and parented assets and skips invalid ones', () => {
    const state = fold(toolCall('codeaudit_set_engagement', '{"target":"t","objective":"o"}', 1, 'e1'))
    const root = applyCodeauditEvent(state, toolCall('codeaudit_add_asset', '{"type":"repo","value":"shop-backend","meta":"main branch"}', 2, 'a1'))
    expect(root.assets).toEqual([{ id: 'asset-1', type: 'repo', value: 'shop-backend', meta: 'main branch' }])
    expect(root.edges).toEqual([])
    const child = applyCodeauditEvent(root, toolCall('codeaudit_add_asset', '{"type":"module","value":"order-service","parentId":"asset-1"}', 3, 'a2'))
    expect(child.assets.at(-1)).toEqual({ id: 'asset-2', type: 'module', value: 'order-service', meta: '' })
    expect(child.edges.at(-1)).toEqual({ id: 'edge-1', kind: 'parent', sourceId: 'asset-1', targetId: 'asset-2' })
    const badType = applyCodeauditEvent(state, toolCall('codeaudit_add_asset', '{"type":"planet","value":"x"}', 2, 'a1'))
    const emptyValue = applyCodeauditEvent(state, toolCall('codeaudit_add_asset', '{"type":"file","value":""}', 2, 'a1'))
    expect(badType).toBe(state)
    expect(emptyValue).toBe(state)
    const badParent = applyCodeauditEvent(root, toolCall('codeaudit_add_asset', '{"type":"file","value":"src/A.java","parentId":"asset-9"}', 3, 'a2'))
    expect(badParent).toBe(root)
    const emptyParent = applyCodeauditEvent(root, toolCall('codeaudit_add_asset', '{"type":"file","value":"src/A.java","parentId":""}', 3, 'a2'))
    expect(emptyParent.assets.at(-1)).toMatchObject({ id: 'asset-2', type: 'file', value: 'src/A.java' })
    expect(emptyParent.edges).toEqual([])
  })

  it('caps nodes, edges, and assets at the newest', () => {
    const engagement = toolCall('codeaudit_set_engagement', '{"target":"t","objective":"o"}', 1, 'e1')
    const many = Array.from({ length: 250 }, (_, index) =>
      toolCall('codeaudit_add_intent', `{"engagementId":"engagement-1","title":"i${index}"}`, 2 + index, `i${2 + index}`))
    const capped = many.reduce(applyCodeauditEvent, fold(engagement))
    expect(capped.nodes).toHaveLength(NODE_CAP)
    expect(capped.nodes[0]).toMatchObject({ id: `intent-${251 - NODE_CAP}` })
    expect(capped.edges).toHaveLength(EDGE_CAP)
    const assets = Array.from({ length: 250 }, (_, index) =>
      toolCall('codeaudit_add_asset', `{"type":"file","value":"src/F${index}.java"}`, 300 + index, `a${300 + index}`))
    const cappedAssets = assets.reduce(applyCodeauditEvent, fold(engagement))
    expect(cappedAssets.assets).toHaveLength(ASSET_CAP)
  })

  it('does not expose edges whose capped endpoints are absent', () => {
    const engagement = toolCall('codeaudit_set_engagement', '{"target":"t","objective":"o"}', 1, 'e1')
    const intents = Array.from({ length: NODE_CAP }, (_, index) =>
      toolCall('codeaudit_add_intent', `{"engagementId":"engagement-1","title":"i${index}"}`, 2 + index, `i${index}`))
    const beforeEvidences = intents.reduce(applyCodeauditEvent, fold(engagement))
    const capped = Array.from({ length: NODE_CAP }, (_, index) =>
      toolCall('codeaudit_add_evidence', `{"intentId":"intent-${index + 1}","detail":"v${index}"}`, 202 + index, `v${index}`))
      .reduce(applyCodeauditEvent, beforeEvidences)
    const ids = new Set(['engagement-1', ...capped.nodes.map(node => node.id), ...capped.assets.map(asset => asset.id)])
    expect(capped.edges.every(edge => ids.has(edge.sourceId) && ids.has(edge.targetId))).toBe(true)
  })

  it('ignores foreign events, read tools, and malformed arguments', () => {
    const engagement = toolCall('codeaudit_set_engagement', '{"target":"t","objective":"o"}', 1, 'e1')
    const clean = fold(engagement)
    const unchanged = fold(
      engagement,
      toolCall('bash', '{"command":"ls"}', 2, 'c2'),
      toolCall('codeaudit_add_evidence', 'not json', 3, 'c3'),
      toolCall('codeaudit_add_evidence', '"just a string"', 4, 'c4'),
      toolCall('codeaudit_state', '{}', 5, 'c5'),
      toolCall('codeaudit_graph', '{}', 6, 'c6'),
      toolCall('codeaudit_report', '{}', 7, 'c7'),
      { type: 'tool/result', seq: 8, time: 8, data: { turn: 1, step: 1, callId: CallId('c3'), name: 'codeaudit_add_evidence', arguments: '{"intentId":"intent-1","detail":"d"}' } } as SessionEvent,
    )
    expect(unchanged).toEqual(clean)
  })
})

describe('viewCodeauditState / codeauditProjectionSchema', () => {
  it('projects null before the first engagement and the standing state afterwards', () => {
    expect(viewCodeauditState(codeauditInitialState)).toBeNull()
    const state = fold(...fullChainEvents())
    const view = viewCodeauditState(state)
    expect(codeauditProjectionSchema.parse(view)).toEqual(view)
    expect(view).toMatchObject({
      engagement: { id: 'engagement-1', target: 'shop-backend' },
      counts: { intents: 2, evidences: 2, findings: 1, assets: 0 },
    })
    expect(codeauditProjectionSchema.parse(null)).toBeNull()
  })
})

describe('codeaudit projection registration', () => {
  it('folds real session events into the snapshot through the projection seam', async () => {
    const { ctx, session } = await codeauditProjectionHarness()
    expect(ctx.sessionProjections.snapshot(session).values['codeaudit']).toBeNull()
    session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('engagement-1'), name: 'codeaudit_set_engagement',
      arguments: '{"target":"shop-backend","objective":"audit injection"}',
    })
    session.append('tool/call', {
      turn: 1, step: 2, callId: CallId('intent-1'), name: 'codeaudit_add_intent',
      arguments: '{"engagementId":"engagement-1","title":"trace order"}',
    })
    session.append('tool/call', {
      turn: 1, step: 3, callId: CallId('evidence-1'), name: 'codeaudit_add_evidence',
      arguments: '{"intentId":"intent-1","kind":"sink","detail":"string concatenation"}',
    })
    expect(ctx.sessionProjections.snapshot(session).values['codeaudit']).toMatchObject({
      engagement: { id: 'engagement-1', target: 'shop-backend', objective: 'audit injection', scope: '', stack: '' },
      counts: { intents: 1, evidences: 1, findings: 0, assets: 0 },
    })
  })

  it('replays the full parent log in seq order: turn-0 synthetic submissions fold after their anchors', async () => {
    // The projection registry folds the log strictly by seq (append order),
    // not by (turn, step): a delegated submission's synthetic tool/call events
    // carry turn 0 but land AFTER the parent's own turn-1 events, so a full-log
    // refold (replay/refresh) sees the engagement and intent before the
    // submission and reproduces the live snapshot exactly.
    const { ctx, session } = await codeauditProjectionHarness()
    session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('engagement-1'), name: 'codeaudit_set_engagement',
      arguments: '{"target":"shop-backend","objective":"audit injection"}',
    })
    session.append('tool/call', {
      turn: 1, step: 2, callId: CallId('intent-1'), name: 'codeaudit_add_intent',
      arguments: '{"engagementId":"engagement-1","title":"delegate order trace"}',
    })
    // The synthetic events a child submission appends: turn 0, steps after the
    // module counter (mirroring appendSubmissionProjection). The finding's
    // evidenceIds reference the same-batch evidence, so the fold order
    // (evidences before findings) matters.
    session.append('tool/call', {
      turn: 0, step: 1, callId: CallId('codeaudit-submit-1'), name: 'codeaudit_add_evidence',
      arguments: '{"intentId":"intent-1","kind":"sink","location":"src/OrderDao.java:87","detail":"string concatenation","snippet":"jdbc.query(\\"...\\" + q)","confidence":0.9}',
    })
    session.append('tool/call', {
      turn: 0, step: 2, callId: CallId('codeaudit-submit-2'), name: 'codeaudit_add_asset',
      arguments: '{"type":"endpoint","value":"GET /api/order","meta":"form"}',
    })
    session.append('tool/call', {
      turn: 0, step: 3, callId: CallId('codeaudit-submit-3'), name: 'codeaudit_add_finding',
      arguments: '{"intentId":"intent-1","title":"sqli","severity":"high","status":"confirmed","location":"src/OrderDao.java:87","evidenceIds":["evidence-1"]}',
    })
    const live = ctx.sessionProjections.snapshot(session).values['codeaudit']
    expect(live).toMatchObject({
      engagement: { id: 'engagement-1', target: 'shop-backend' },
      counts: { intents: 1, evidences: 1, findings: 1, assets: 1 },
    })
    expect(live?.edges).toEqual(expect.arrayContaining([
      { id: 'edge-2', kind: 'yields', sourceId: 'intent-1', targetId: 'evidence-1' },
      { id: 'edge-3', kind: 'proves', sourceId: 'intent-1', targetId: 'finding-1' },
      { id: 'edge-4', kind: 'supports', sourceId: 'evidence-1', targetId: 'finding-1' },
    ]))
    // Full-log refold from init over the same events (the replay a refresh or
    // a cold restore performs): the fold result must equal the live snapshot.
    const replayed = session.events.reduce(applyCodeauditEvent, codeauditInitialState)
    expect(viewCodeauditState(replayed)).toEqual(live)
  })
})
