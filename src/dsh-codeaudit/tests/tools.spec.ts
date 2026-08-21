/**
 * Behavior of the model-facing `codeaudit_*` tools over the real store: the
 * audit chain (engagement → intent → evidence → derived intent → finding with
 * its supports evidence chain), the asset graph, snippet capping, session
 * scoping, referential validation, deterministic ids, and the non-agent
 * rejection.
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SNIPPET_MAX_CHARS, codeauditDomainSpec } from '../src/spec.ts'
import { codeauditHarness, SESSION_ID } from './harness.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** The recorded write results of one full chain. */
interface ChainWrites {
  engagement: Record<string, unknown>
  intentA: Record<string, unknown>
  entry: Record<string, unknown>
  intentB: Record<string, unknown>
  sink: Record<string, unknown>
  finding: Record<string, unknown>
}

/** Drive one full audit chain and return the recorded write results. */
async function fullChain(
  call: (name: string, args: unknown, sessionId: string) => Promise<unknown>,
): Promise<ChainWrites> {
  const engagement = await call('codeaudit_set_engagement', {
    target: 'shop-backend', objective: 'audit injection and authz', scope: 'src/main only', stack: 'Java/Spring',
  }, SESSION_ID) as Record<string, unknown>
  const intentA = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace /api/order params', detail: 'source → sink' }, SESSION_ID) as Record<string, unknown>
  const entry = await call('codeaudit_add_evidence', {
    intentId: intentA.id, kind: 'entry', location: 'src/OrderController.java:42', detail: '@RequestParam q reaches DAO unencoded', confidence: 0.9, snippet: 'public List<Order> find(@RequestParam String q) {',
  }, SESSION_ID) as Record<string, unknown>
  const intentB = await call('codeaudit_add_intent', { derivedFromEvidenceId: entry.id, title: 'trace OrderDao sink' }, SESSION_ID) as Record<string, unknown>
  const sink = await call('codeaudit_add_evidence', {
    intentId: intentB.id, kind: 'sink', location: 'src/OrderDao.java:87', detail: 'query built by string concatenation', snippet: 'return jdbc.query("... where name = \'" + q + "\'");',
  }, SESSION_ID) as Record<string, unknown>
  const finding = await call('codeaudit_add_finding', {
    intentId: intentB.id, title: 'SQL injection in OrderDao.findByUser', severity: 'high', status: 'confirmed',
    location: 'src/OrderDao.java:87', cwe: 'CWE-89', evidenceIds: [sink.id],
    description: 'User input concatenated into SQL', fix: 'Use a parameterized query',
    poc: 'POST /api/order HTTP/1.1\nHost: shop.example.com\n\nq=1%27',
  }, SESSION_ID) as Record<string, unknown>
  return { engagement, intentA, entry, intentB, sink, finding }
}

describe('codeaudit_set_engagement', () => {
  it('records the engagement with a deterministic id, scope, and stack', async () => {
    const { call } = await codeauditHarness()
    const engagement = await call('codeaudit_set_engagement', {
      target: 'shop-backend', objective: 'audit injection', scope: 'src/main only', stack: 'Java/Spring',
    }, SESSION_ID) as Record<string, unknown>
    expect(engagement).toMatchObject({ id: 'engagement-1', target: 'shop-backend', objective: 'audit injection' })
    const view = await call('codeaudit_state', {}, SESSION_ID) as Record<string, unknown>
    expect(view).toMatchObject({ initialized: true })
    expect(view.engagement).toMatchObject({ id: 'engagement-1', scope: 'src/main only', stack: 'Java/Spring' })
  })

  it('migrates legacy keys without overwriting an existing session-scoped record', async () => {
    const { call, facility } = await codeauditHarness()
    const domain = await facility.open(codeauditDomainSpec)
    await domain.table('engagements').put(SESSION_ID, {
      id: 'engagement-1', sessionId: SESSION_ID, target: 'shop-backend', objective: 'o', scope: '', stack: '',
    })
    await domain.table('intents').put('intent-1', {
      id: 'intent-1', sessionId: SESSION_ID, title: 'legacy', detail: '',
    })
    await domain.table('intents').put(`${SESSION_ID}:intent-1`, {
      id: 'intent-1', sessionId: SESSION_ID, title: 'scoped', detail: '',
    })
    await domain.table('assets').put('asset-1', {
      id: 'asset-1', sessionId: SESSION_ID, type: 'repo', value: 'legacy/shop-backend', meta: '',
    })
    await domain.close()

    const state = await call('codeaudit_state', {}, SESSION_ID) as { intents: Array<{ title: string }>; assets: Array<{ value: string }> }
    expect(state.intents).toEqual([expect.objectContaining({ title: 'scoped' })])
    expect(state.assets).toEqual([expect.objectContaining({ value: 'legacy/shop-backend' })])
  })

  it('resets the whole audit graph when a new engagement is recorded', async () => {
    const { call } = await codeauditHarness()
    const { intentA } = await fullChain(call)
    expect(intentA.id).toBe('intent-1')
    await call('codeaudit_set_engagement', { target: 'other-service', objective: 'fresh' }, SESSION_ID)
    const view = await call('codeaudit_state', {}, SESSION_ID) as Record<string, unknown>
    expect(view.counts).toMatchObject({ intents: 0, evidences: 0, findings: 0, assets: 0 })
    // Counters restart: the first intent of the new engagement is intent-1 again.
    const fresh = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'fresh intent' }, SESSION_ID) as Record<string, unknown>
    expect(fresh.id).toBe('intent-1')
  })
})

describe('codeaudit_submit', () => {
  it('lets a delegated child submit a compact result into its parent intent', async () => {
    const { call, callAsChild, ctx } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace login' }, SESSION_ID) as { id: string }
    await expect(callAsChild('codeaudit_submit', {
      intentId: intent.id,
      evidences: [{ kind: 'sink', location: 'src/LoginDao.java:30', detail: 'concatenated password query', snippet: '"... pwd = \'" + pwd' }],
      assets: [{ type: 'endpoint', value: 'POST /login', meta: 'form' }],
      findings: [],
    }, SESSION_ID)).resolves.toMatchObject({ evidences: 1, assets: 1, findings: 0 })
    const state = await call('codeaudit_state', {}, SESSION_ID) as { evidences: Array<{ detail: string }>; assets: Array<{ value: string }> }
    expect(state.evidences).toEqual([expect.objectContaining({ detail: 'concatenated password query' })])
    expect(state.assets).toEqual([expect.objectContaining({ value: 'POST /login' })])
    expect(ctx.sessions.get(SESSION_ID as never)?.events.some(event =>
      event.type === 'tool/call' && event.data.name === 'codeaudit_add_asset',
    )).toBe(true)
  })

  it('accepts a finding whose evidence chain lands in the same batch', async () => {
    const { call, callAsChild } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace order' }, SESSION_ID) as { id: string }
    await expect(callAsChild('codeaudit_submit', {
      intentId: intent.id,
      evidences: [
        { kind: 'entry', location: 'src/OrderController.java:42', detail: 'q reaches DAO' },
        { kind: 'sink', location: 'src/OrderDao.java:87', detail: 'string concatenation' },
      ],
      assets: [],
      findings: [{
        title: 'SQLi in OrderDao', severity: 'high', status: 'confirmed', location: 'src/OrderDao.java:87',
        evidenceIds: ['evidence-1', 'evidence-2'], cwe: 'CWE-89',
      }],
    }, SESSION_ID)).resolves.toMatchObject({ evidences: 2, assets: 0, findings: 1, evidenceIds: ['evidence-1', 'evidence-2'] })
    const graph = await call('codeaudit_graph', {}, SESSION_ID) as { graph: { edges: Array<{ kind: string; sourceId: string; targetId: string }> } }
    expect(graph.graph.edges.map(edge => ({ kind: edge.kind, sourceId: edge.sourceId, targetId: edge.targetId }))).toEqual([
      { kind: 'spawns', sourceId: 'engagement-1', targetId: 'intent-1' },
      { kind: 'yields', sourceId: 'intent-1', targetId: 'evidence-1' },
      { kind: 'yields', sourceId: 'intent-1', targetId: 'evidence-2' },
      { kind: 'proves', sourceId: 'intent-1', targetId: 'finding-1' },
      { kind: 'supports', sourceId: 'evidence-1', targetId: 'finding-1' },
      { kind: 'supports', sourceId: 'evidence-2', targetId: 'finding-1' },
    ])
  })

  it('rejects a root session without a parent target', async () => {
    const { call } = await codeauditHarness()
    await expect(call('codeaudit_submit', { intentId: 'intent-1', evidences: [], assets: [], findings: [] }, SESSION_ID))
      .rejects.toThrow(/only available to a delegated subagent/)
  })

  it('rejects a placeholder parent intent id without writing to the parent graph', async () => {
    const { call, callAsChild } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace login' }, SESSION_ID)
    await expect(callAsChild('codeaudit_submit', {
      intentId: 'delegation-intent-id',
      evidences: [{ detail: 'sink found' }],
      assets: [{ type: 'endpoint', value: '/login' }],
      findings: [],
    }, SESSION_ID)).rejects.toThrow(/concrete parent intent ID.*placeholder "delegation-intent-id"/)
    const state = await call('codeaudit_state', {}, SESSION_ID) as { evidences: unknown[]; assets: unknown[] }
    expect(state.evidences).toEqual([])
    expect(state.assets).toEqual([])
  })

  it('does not persist a child submission when its parent session is not live', async () => {
    const { call, callAsChildWithoutParent } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace login' }, SESSION_ID) as { id: string }
    await expect(callAsChildWithoutParent('codeaudit_submit', {
      intentId: intent.id,
      evidences: [{ detail: 'sink found' }],
      assets: [],
      findings: [],
    }, SESSION_ID)).rejects.toThrow(/parent session session-a is not live/)
    const state = await call('codeaudit_state', {}, SESSION_ID) as { evidences: unknown[] }
    expect(state.evidences).toEqual([])
  })

  it('rolls back a mixed submission when any referenced record is invalid', async () => {
    const { call, callAsChild } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace login' }, SESSION_ID) as { id: string }
    await expect(callAsChild('codeaudit_submit', {
      intentId: intent.id,
      evidences: [{ detail: 'sink found' }],
      assets: [{ type: 'file', value: 'src/Login.java', parentId: 'asset-404' }],
      findings: [],
    }, SESSION_ID)).rejects.toThrow(/unknown asset asset-404/)
    const state = await call('codeaudit_state', {}, SESSION_ID) as { evidences: unknown[]; assets: unknown[] }
    expect(state.evidences).toEqual([])
    expect(state.assets).toEqual([])
  })

  it('rejects a finding without a usable evidence chain and rolls the batch back', async () => {
    const { call, callAsChild } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace login' }, SESSION_ID) as { id: string }
    await expect(callAsChild('codeaudit_submit', {
      intentId: intent.id,
      evidences: [{ detail: 'sink found' }],
      assets: [],
      findings: [{ title: 'no evidence', severity: 'high', status: 'confirmed', location: 'src/x.java:1', evidenceIds: ['evidence-9'] }],
    }, SESSION_ID)).rejects.toThrow(/unknown evidence evidence-9/)
    const state = await call('codeaudit_state', {}, SESSION_ID) as { evidences: unknown[]; findings: unknown[] }
    expect(state.evidences).toEqual([])
    expect(state.findings).toEqual([])
  })

  it('rolls the id counters back with a failed submission, so a retry starts at evidence-1 again', async () => {
    // Regression: a rejected submission used to leave the evidence counter
    // advanced while the session projection (which only folds logged events)
    // stayed behind — the store's evidence-3 was the fold's evidence-1 and the
    // Web findings view stopped showing records the report still listed.
    const { call, callAsChild } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace login' }, SESSION_ID) as { id: string }
    // Failed attempt: the finding's evidence reference fails AFTER the batch
    // evidences were already written (and rolled back).
    await expect(callAsChild('codeaudit_submit', {
      intentId: intent.id,
      evidences: [{ detail: 'first attempt' }],
      assets: [],
      findings: [{ title: 'guessed ref', severity: 'high', status: 'confirmed', location: 'a:1', evidenceIds: ['evidence-7'] }],
    }, SESSION_ID)).rejects.toThrow(/unknown evidence evidence-7/)
    // Retry succeeds: the counters restarted, so the ids match what the
    // projection fold assigns from the logged events.
    const assigned = await callAsChild('codeaudit_submit', {
      intentId: intent.id,
      evidences: [{ detail: 'second attempt' }],
      assets: [],
      findings: [],
    }, SESSION_ID) as { evidenceIds: string[] }
    expect(assigned.evidenceIds).toEqual(['evidence-1'])
    const state = await call('codeaudit_state', {}, SESSION_ID) as { evidences: Array<{ id: string; detail: string }> }
    expect(state.evidences).toEqual([expect.objectContaining({ id: 'evidence-1', detail: 'second attempt' })])
  })

  it('returns the ids assigned to the batch so the caller never guesses', async () => {
    const { call, callAsChild } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace' }, SESSION_ID) as { id: string }
    const first = await callAsChild('codeaudit_submit', {
      intentId: intent.id,
      evidences: [{ detail: 'entry' }, { detail: 'sink' }],
      assets: [{ type: 'file', value: 'src/A.java' }],
      findings: [],
    }, SESSION_ID) as { evidenceIds: string[]; assetIds: string[] }
    expect(first.evidenceIds).toEqual(['evidence-1', 'evidence-2'])
    expect(first.assetIds).toEqual(['asset-1'])
    // The second batch references the RETURNED ids — the store accepts them,
    // and the projection fold resolves them identically.
    await expect(callAsChild('codeaudit_submit', {
      intentId: intent.id,
      evidences: [],
      assets: [],
      findings: [{ title: 'chain ok', severity: 'high', status: 'confirmed', location: 'src/A.java:9', evidenceIds: first.evidenceIds }],
    }, SESSION_ID)).resolves.toMatchObject({ findings: 1, findingIds: ['finding-1'] })
  })

  it('caps submitted snippets at the durable limit', async () => {
    const { call, callAsChild } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace' }, SESSION_ID) as { id: string }
    const long = 'x'.repeat(SNIPPET_MAX_CHARS + 100)
    await callAsChild('codeaudit_submit', {
      intentId: intent.id,
      evidences: [{ detail: 'sink found', snippet: long }],
      assets: [],
      findings: [],
    }, SESSION_ID)
    const view = await call('codeaudit_state', {}, SESSION_ID) as { evidences: Array<{ snippet: string }> }
    expect(view.evidences[0]?.snippet).toHaveLength(SNIPPET_MAX_CHARS)
  })

  it('normalizes percentage confidence from a delegated child', async () => {
    const { call, callAsChild } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace login' }, SESSION_ID) as { id: string }
    await callAsChild('codeaudit_submit', {
      intentId: intent.id,
      evidences: [{ detail: 'sink found', confidence: '90%' }],
      assets: [],
      findings: [],
    }, SESSION_ID)
    const view = await call('codeaudit_state', {}, SESSION_ID) as { evidences: Array<{ confidence: number }> }
    expect(view.evidences[0]?.confidence).toBe(0.9)
  })

  it('validates delegated input and accepts links to an existing asset', async () => {
    const { call, callAsChild } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace login' }, SESSION_ID) as { id: string }
    const root = await call('codeaudit_add_asset', { type: 'repo', value: 'shop-backend' }, SESSION_ID) as { id: string }
    const submit = (evidences: unknown, assets: unknown, findings: unknown) => callAsChild('codeaudit_submit', { intentId: intent.id, evidences, assets, findings }, SESSION_ID)
    await expect(submit('bad', [], [])).rejects.toThrow(/evidences.*array/)
    await expect(submit([{}], [], [])).rejects.toThrow(/evidence.*detail/)
    await expect(submit([{ detail: 'x', kind: 'invalid' }], [], [])).rejects.toThrow(/evidence.kind.*one of|invalid arguments/)
    await expect(submit([{ detail: 'x', confidence: -1 }], [], [])).rejects.toThrow(/confidence must be/)
    await expect(submit([{ detail: 'x', confidence: 101 }], [], [])).rejects.toThrow(/confidence must be/)
    await expect(submit([], [], [{ title: 'x', location: 'a.java:1', evidenceIds: [] }])).rejects.toThrow(/evidenceIds must be a non-empty array/)
    await expect(submit([], [], [{ title: 'x', evidenceIds: ['evidence-1'] }])).rejects.toThrow(/findings\[0\]\.location|finding\.location/)
    await expect(submit([{ detail: 'linked sink' }], [{ type: 'file', value: 'src/Login.java', parentId: root.id }], [{
      title: 'linked finding', severity: 'high', status: 'confirmed', location: 'src/Login.java:30', evidenceIds: ['evidence-1'], affectedAssetId: root.id,
    }])).resolves.toMatchObject({ evidences: 1, assets: 1, findings: 1 })
  })
})

describe('codeaudit_add_intent', () => {
  it('rejects writes before codeaudit_set_engagement', async () => {
    const { call } = await codeauditHarness()
    await expect(call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'x' }, SESSION_ID))
      .rejects.toThrow(/not initialized/)
  })

  it('requires exactly one anchor', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    await expect(call('codeaudit_add_intent', { title: 'x' }, SESSION_ID))
      .rejects.toThrow(/exactly one anchor/)
    await expect(call('codeaudit_add_intent', { title: 'x', engagementId: 'engagement-1', derivedFromEvidenceId: 'evidence-1' }, SESSION_ID))
      .rejects.toThrow(/exactly one anchor/)
  })

  it('rejects an unknown engagement anchor without changing the graph', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    await expect(call('codeaudit_add_intent', { engagementId: 'engagement-9', title: 'x' }, SESSION_ID))
      .rejects.toThrow(/unknown engagement engagement-9/)
    const state = await call('codeaudit_state', {}, SESSION_ID) as { counts: unknown }
    expect(state.counts).toEqual({ intents: 0, evidences: 0, findings: 0, assets: 0 })
  })

  it('records a spawns intent under the engagement', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const write = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace order', detail: 'scope: src/main' }, SESSION_ID) as Record<string, unknown>
    expect(write).toMatchObject({ id: 'intent-1', edgeId: 'edge-1', edgeKind: 'spawns', sourceId: 'engagement-1' })
  })

  it('records a derived_from intent under an evidence and rejects unknown anchors', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'a' }, SESSION_ID) as Record<string, unknown>
    const evidence = await call('codeaudit_add_evidence', { intentId: intent.id, detail: 'sink found' }, SESSION_ID) as Record<string, unknown>
    const derived = await call('codeaudit_add_intent', { derivedFromEvidenceId: evidence.id, title: 'b' }, SESSION_ID) as Record<string, unknown>
    expect(derived).toMatchObject({ id: 'intent-2', edgeKind: 'derived_from', sourceId: evidence.id })
    await expect(call('codeaudit_add_intent', { derivedFromEvidenceId: 'evidence-99', title: 'c' }, SESSION_ID))
      .rejects.toThrow(/unknown evidence evidence-99/)
    // IDs restart for each session. Use a second foreign evidence so its bare
    // id cannot resolve to the current session's valid evidence-1.
    await call('codeaudit_set_engagement', { target: 'other', objective: 'o' }, 'session-b')
    const foreignIntent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'b' }, 'session-b') as Record<string, unknown>
    await call('codeaudit_add_evidence', { intentId: foreignIntent.id, detail: 'first' }, 'session-b')
    const foreignEvidence = await call('codeaudit_add_evidence', { intentId: foreignIntent.id, detail: 'second' }, 'session-b') as Record<string, unknown>
    await expect(call('codeaudit_add_intent', { derivedFromEvidenceId: foreignEvidence.id, title: 'c' }, SESSION_ID))
      .rejects.toThrow(/unknown evidence evidence-2/)
  })
})

describe('concurrent graph writes', () => {
  it('allocates unique ids for concurrent evidences in one session', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'probe' }, SESSION_ID) as { id: string }
    const writes = await Promise.all([
      call('codeaudit_add_evidence', { intentId: intent.id, detail: 'first' }, SESSION_ID),
      call('codeaudit_add_evidence', { intentId: intent.id, detail: 'second' }, SESSION_ID),
    ]) as Array<{ id: string }>
    expect(writes.map(write => write.id).sort()).toEqual(['evidence-1', 'evidence-2'])
    const state = await call('codeaudit_state', {}, SESSION_ID) as { evidences: Array<{ id: string }> }
    expect(state.evidences.map(evidence => evidence.id)).toEqual(['evidence-1', 'evidence-2'])
  })
})

describe('codeaudit_add_evidence', () => {
  it('records an evidence yielded by an intent with defaults and explicit values', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'a' }, SESSION_ID) as Record<string, unknown>
    const evidence = await call('codeaudit_add_evidence', {
      intentId: intent.id, kind: 'sink', location: 'src/OrderDao.java:87', detail: 'concatenated query', confidence: 0.9, snippet: 'query = "..." + q',
    }, SESSION_ID) as Record<string, unknown>
    expect(evidence).toMatchObject({ id: 'evidence-1', kind: 'sink', detail: 'concatenated query', edgeId: 'edge-2' })
    await call('codeaudit_add_evidence', { intentId: intent.id, detail: 'framework config present' }, SESSION_ID)
    const view = await call('codeaudit_state', {}, SESSION_ID) as Record<string, unknown>
    expect(view.counts).toMatchObject({ evidences: 2 })
    const evidences = (view.evidences as Array<Record<string, unknown>>).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    expect(evidences[0]).toMatchObject({ kind: 'sink', location: 'src/OrderDao.java:87', snippet: 'query = "..." + q', confidence: 0.9 })
    expect(evidences[1]).toMatchObject({ kind: 'info', location: '', snippet: '', confidence: 0.5 })
  })

  it('rejects unknown intent references, including ids from another session', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    await expect(call('codeaudit_add_evidence', { intentId: 'intent-99', detail: 'x' }, SESSION_ID))
      .rejects.toThrow(/unknown intent intent-99/)
    await call('codeaudit_set_engagement', { target: 'other', objective: 'o' }, 'session-b')
    const foreign = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'b' }, 'session-b') as Record<string, unknown>
    await expect(call('codeaudit_add_evidence', { intentId: foreign.id, detail: 'x' }, SESSION_ID))
      .rejects.toThrow(/unknown intent intent-1/)
  })
})

describe('codeaudit_add_finding', () => {
  it('records a finding with its evidence chain: proves plus supports edges', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'trace order' }, SESSION_ID) as Record<string, unknown>
    await call('codeaudit_add_evidence', { intentId: intent.id, kind: 'entry', location: 'src/OrderController.java:42', detail: 'q unvalidated' }, SESSION_ID)
    await call('codeaudit_add_evidence', { intentId: intent.id, kind: 'sink', location: 'src/OrderDao.java:87', detail: 'concatenation' }, SESSION_ID)
    const finding = await call('codeaudit_add_finding', {
      intentId: intent.id, title: 'SQL injection in OrderDao', severity: 'high', status: 'confirmed',
      location: 'src/OrderDao.java:87', cwe: 'CWE-89', evidenceIds: ['evidence-1', 'evidence-2'],
      description: 'Injectable parameter', fix: 'Parameterize the query', snippet: 'return jdbc.query("..." + q);',
    }, SESSION_ID) as Record<string, unknown>
    expect(finding).toMatchObject({ id: 'finding-1', title: 'SQL injection in OrderDao', severity: 'high', edgeIds: ['edge-4', 'edge-5', 'edge-6'] })
    const graph = await call('codeaudit_graph', {}, SESSION_ID) as { graph: { edges: Array<{ id: string; kind: string; sourceId: string; targetId: string }>; findings: Array<Record<string, unknown>> } }
    expect(graph.graph.edges).toEqual([
      { id: 'edge-1', sessionId: SESSION_ID, kind: 'spawns', sourceId: 'engagement-1', targetId: 'intent-1' },
      { id: 'edge-2', sessionId: SESSION_ID, kind: 'yields', sourceId: 'intent-1', targetId: 'evidence-1' },
      { id: 'edge-3', sessionId: SESSION_ID, kind: 'yields', sourceId: 'intent-1', targetId: 'evidence-2' },
      { id: 'edge-4', sessionId: SESSION_ID, kind: 'proves', sourceId: 'intent-1', targetId: 'finding-1' },
      { id: 'edge-5', sessionId: SESSION_ID, kind: 'supports', sourceId: 'evidence-1', targetId: 'finding-1' },
      { id: 'edge-6', sessionId: SESSION_ID, kind: 'supports', sourceId: 'evidence-2', targetId: 'finding-1' },
    ])
    expect(graph.graph.findings[0]).toMatchObject({
      status: 'confirmed', cwe: 'CWE-89', location: 'src/OrderDao.java:87', fix: 'Parameterize the query', snippet: 'return jdbc.query("..." + q);',
    })
  })

  it('links an affected asset and rejects unknown asset ids', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'a' }, SESSION_ID) as Record<string, unknown>
    const evidence = await call('codeaudit_add_evidence', { intentId: intent.id, detail: 'sink' }, SESSION_ID) as { id: string }
    const asset = await call('codeaudit_add_asset', { type: 'endpoint', value: 'GET /search' }, SESSION_ID) as Record<string, unknown>
    const finding = await call('codeaudit_add_finding', {
      intentId: intent.id, title: 'sqli', severity: 'high', status: 'confirmed', location: 'src/Search.java:9',
      evidenceIds: [evidence.id], affectedAssetId: asset.id,
    }, SESSION_ID) as Record<string, unknown>
    expect(finding.id).toBe('finding-1')
    await expect(call('codeaudit_add_finding', {
      intentId: intent.id, title: 'x', severity: 'low', status: 'suspected', location: 'a:1', evidenceIds: [evidence.id], affectedAssetId: 'asset-99',
    }, SESSION_ID)).rejects.toThrow(/unknown asset asset-99/)
    await call('codeaudit_set_engagement', { target: 'other', objective: 'o' }, 'session-b')
    await call('codeaudit_add_asset', { type: 'config', value: 'prod.yaml' }, 'session-b')
    const foreignAsset = await call('codeaudit_add_asset', { type: 'config', value: 'staging.yaml' }, 'session-b') as Record<string, unknown>
    await expect(call('codeaudit_add_finding', {
      intentId: intent.id, title: 'x', severity: 'low', status: 'suspected', location: 'a:1', evidenceIds: [evidence.id], affectedAssetId: foreignAsset.id,
    }, SESSION_ID)).rejects.toThrow(/unknown asset asset-2/)
  })

  it('rejects findings without location or evidence references', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'a' }, SESSION_ID) as Record<string, unknown>
    await expect(call('codeaudit_add_finding', {
      intentId: intent.id, title: 'no chain', severity: 'info', status: 'suspected', location: 'a:1', evidenceIds: [],
    }, SESSION_ID)).rejects.toThrow(/at least one evidence/)
    // The rejected write must not have landed a finding.
    const view = await call('codeaudit_state', {}, SESSION_ID) as Record<string, unknown>
    expect(view.counts).toMatchObject({ findings: 0 })
  })
})

describe('codeaudit_add_asset', () => {
  it('records a root asset without an edge and a parented asset with a parent edge', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const root = await call('codeaudit_add_asset', { type: 'repo', value: 'shop-backend', meta: 'main branch' }, SESSION_ID) as Record<string, unknown>
    expect(root).toMatchObject({ id: 'asset-1', type: 'repo', value: 'shop-backend' })
    expect(root.edgeId).toBeUndefined()
    const module = await call('codeaudit_add_asset', { type: 'module', value: 'order-service', parentId: root.id }, SESSION_ID) as Record<string, unknown>
    expect(module).toMatchObject({ id: 'asset-2', edgeId: 'edge-1' })
    const graph = await call('codeaudit_graph', {}, SESSION_ID) as Record<string, unknown>
    expect((graph.graph as Record<string, unknown>).edges).toEqual([
      { id: 'edge-1', sessionId: SESSION_ID, kind: 'parent', sourceId: 'asset-1', targetId: 'asset-2' },
    ])
  })

  it('rejects unknown parent references, including ids from another session', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    await expect(call('codeaudit_add_asset', { type: 'file', value: 'src/A.java', parentId: 'asset-99' }, SESSION_ID))
      .rejects.toThrow(/unknown asset asset-99/)
    await call('codeaudit_set_engagement', { target: 'other', objective: 'o' }, 'session-b')
    const foreign = await call('codeaudit_add_asset', { type: 'file', value: 'src/B.java' }, 'session-b') as Record<string, unknown>
    await expect(call('codeaudit_add_asset', { type: 'file', value: 'src/C.java', parentId: foreign.id }, SESSION_ID))
      .rejects.toThrow(/unknown asset asset-1/)
  })

  it('accepts an empty-string parentId as a root asset', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const root = await call('codeaudit_add_asset', {
      type: 'repo', value: 'shop-backend', parentId: '',
    }, SESSION_ID) as Record<string, unknown>
    expect(root).toMatchObject({ id: 'asset-1', type: 'repo', value: 'shop-backend' })
    expect(root.edgeId).toBeUndefined()
    const graph = await call('codeaudit_graph', {}, SESSION_ID) as Record<string, unknown>
    expect((graph.graph as Record<string, unknown>).edges).toEqual([])
  })
})

describe('codeaudit_state', () => {
  it('reports an uninitialized session without throwing', async () => {
    const { call } = await codeauditHarness()
    await expect(call('codeaudit_state', {}, SESSION_ID)).resolves.toMatchObject({
      initialized: false, counts: { intents: 0, evidences: 0, findings: 0, assets: 0 },
    })
  })

  it('declares every field returned by the state view', async () => {
    const { ctx, call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const tool = ctx.tools.get('codeaudit_state') as unknown as {
      output: { schema: { properties: Record<string, unknown> } }
    }
    expect(Object.keys(tool.output.schema.properties)).toEqual(expect.arrayContaining([
      'initialized', 'engagement', 'counts', 'intents', 'evidences', 'findings', 'assets', 'edges',
    ]))
  })

  it('keeps sessions isolated: a fresh session sees none of another session\'s records', async () => {
    const { call } = await codeauditHarness()
    await fullChain(call)
    await expect(call('codeaudit_state', {}, 'session-b')).resolves.toMatchObject({ initialized: false })
    // A subagent session cannot write records before its own engagement either.
    await expect(call('codeaudit_add_evidence', { intentId: 'intent-1', detail: 'x' }, 'session-b'))
      .rejects.toThrow(/not initialized/)
  })

  it('keeps same-named records from separate sessions under distinct storage keys', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'one', objective: 'one' }, SESSION_ID)
    await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'first' }, SESSION_ID)
    await call('codeaudit_set_engagement', { target: 'two', objective: 'two' }, 'session-b')
    await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'second' }, 'session-b')
    const first = await call('codeaudit_state', {}, SESSION_ID) as { engagement?: { target: string }; intents: Array<{ title: string }> }
    const second = await call('codeaudit_state', {}, 'session-b') as { engagement?: { target: string }; intents: Array<{ title: string }> }
    expect(first).toMatchObject({ engagement: { target: 'one' }, intents: [{ title: 'first' }] })
    expect(second).toMatchObject({ engagement: { target: 'two' }, intents: [{ title: 'second' }] })
  })
})

describe('codeaudit_graph and codeaudit_report', () => {
  it('dumps the full audit graph', async () => {
    const { call } = await codeauditHarness()
    await fullChain(call)
    const dump = await call('codeaudit_graph', {}, SESSION_ID) as Record<string, unknown>
    const graph = dump.graph as Record<string, unknown>
    expect(graph.engagement).toMatchObject({ id: 'engagement-1', target: 'shop-backend' })
    expect(graph.intents).toHaveLength(2)
    expect(graph.evidences).toHaveLength(2)
    expect(graph.findings).toHaveLength(1)
    expect(graph.edges).toEqual([
      { id: 'edge-1', sessionId: SESSION_ID, kind: 'spawns', sourceId: 'engagement-1', targetId: 'intent-1' },
      { id: 'edge-2', sessionId: SESSION_ID, kind: 'yields', sourceId: 'intent-1', targetId: 'evidence-1' },
      { id: 'edge-3', sessionId: SESSION_ID, kind: 'derived_from', sourceId: 'evidence-1', targetId: 'intent-2' },
      { id: 'edge-4', sessionId: SESSION_ID, kind: 'yields', sourceId: 'intent-2', targetId: 'evidence-2' },
      { id: 'edge-5', sessionId: SESSION_ID, kind: 'proves', sourceId: 'intent-2', targetId: 'finding-1' },
      { id: 'edge-6', sessionId: SESSION_ID, kind: 'supports', sourceId: 'evidence-2', targetId: 'finding-1' },
    ])
  })

  it('dumps a null engagement for an uninitialized session', async () => {
    const { call } = await codeauditHarness()
    const dump = await call('codeaudit_graph', {}, SESSION_ID) as Record<string, unknown>
    expect((dump.graph as Record<string, unknown>).engagement).toBeNull()
  })

  it('builds a report with the executive summary, chain, evidence chains, and assets', async () => {
    const { call } = await codeauditHarness()
    await fullChain(call)
    await call('codeaudit_add_asset', { type: 'repo', value: 'shop-backend', meta: 'main branch' }, SESSION_ID)
    await call('codeaudit_add_asset', { type: 'endpoint', value: 'GET /api/order', parentId: 'asset-1' }, SESSION_ID)
    const report = await call('codeaudit_report', {}, SESSION_ID) as Record<string, unknown>
    const markdown = report.markdown as string
    expect(markdown).toContain('## 执行摘要')
    expect(markdown).toContain('发现合计: 1（confirmed 1 / suspected 0）')
    expect(markdown).toContain('任务 (engagement engagement-1)「shop-backend」— 审计目标: audit injection and authz')
    expect(markdown).toContain('意图 (intent intent-1)「trace /api/order params」(spawns engagement-1) — source → sink')
    expect(markdown).toContain('证据 (evidence evidence-1) [entry] src/OrderController.java:42: @RequestParam q reaches DAO unencoded (yields intent-1)')
    expect(markdown).toContain('漏洞 (finding finding-1) [high|confirmed] SQL injection in OrderDao.findByUser (proves intent-2)')
    expect(markdown).toContain('### finding-1 [high|confirmed] SQL injection in OrderDao.findByUser')
    expect(markdown).toContain('- CWE: CWE-89')
    expect(markdown).toContain('- 位置: src/OrderDao.java:87')
    expect(markdown).toContain('- 修复建议: Use a parameterized query')
    expect(markdown).toContain('1. evidence-2 [sink] src/OrderDao.java:87 query built by string concatenation')
    expect(markdown).toContain('- POC (HTTP raw，可直接粘贴 Yakit/Burp 重放):')
    expect(markdown).toContain('  POST /api/order HTTP/1.1')
    expect(markdown).toContain('- 影响资产: （未关联）')
    expect(markdown).toContain('- [repo] shop-backend（main branch）')
    expect(markdown).toContain('- [endpoint] GET /api/order ← shop-backend')
  })

  it('builds a report for an engagement-only session and for a linked finding', async () => {
    const { call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    const goalOnly = await call('codeaudit_report', {}, SESSION_ID) as Record<string, unknown>
    expect(goalOnly.markdown).toContain('（仅任务，尚未展开）')
    expect(goalOnly.markdown).toContain('## 漏洞发现\n（无）')
    await call('codeaudit_add_asset', { type: 'repo', value: 'shop-backend' }, SESSION_ID)
    const intent = await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'a' }, SESSION_ID) as Record<string, unknown>
    const evidence = await call('codeaudit_add_evidence', { intentId: intent.id, detail: 'sink' }, SESSION_ID) as { id: string }
    await call('codeaudit_add_finding', {
      intentId: intent.id, title: 'n', severity: 'critical', status: 'suspected', location: 'a:1', evidenceIds: [evidence.id], affectedAssetId: 'asset-1',
    }, SESSION_ID)
    const linked = await call('codeaudit_report', {}, SESSION_ID) as Record<string, unknown>
    expect(linked.markdown).toContain('- 影响资产: [repo] shop-backend')
    expect(linked.markdown).toContain('- 描述: （无）')
    expect(linked.markdown).toContain('发现合计: 1（confirmed 0 / suspected 1）')
  })

  it('reports an uninitialized session', async () => {
    const { call } = await codeauditHarness()
    const report = await call('codeaudit_report', {}, SESSION_ID) as Record<string, unknown>
    expect(report.markdown).toContain('未初始化')
  })
})

describe('caller authority', () => {
  it('rejects tool calls without an owning agent session', async () => {
    const { callWithoutAgent } = await codeauditHarness()
    await expect(callWithoutAgent('codeaudit_set_engagement', { target: 't', objective: 'o' }))
      .rejects.toThrow(/require an owning agent session/)
  })
})

describe('tool renders', () => {
  it('renders each write tool result as model-visible text carrying the ids', async () => {
    const { render } = await codeauditHarness()
    expect(render('codeaudit_set_engagement', {}, { id: 'engagement-1', target: 'shop-backend', objective: 'o' })).toEqual(
      [{ type: 'text', text: 'Recorded engagement engagement-1 → shop-backend.' }],
    )
    expect(render('codeaudit_add_intent', {}, {
      id: 'intent-1', title: 'trace order', edgeId: 'edge-1', edgeKind: 'spawns', sourceId: 'engagement-1',
    })).toEqual(
      [{ type: 'text', text: 'Recorded intent intent-1「trace order」 (spawns engagement-1 → intent-1, edge edge-1).' }],
    )
    expect(render('codeaudit_add_evidence', {}, { id: 'evidence-1', kind: 'sink', detail: 'concatenation', edgeId: 'edge-2' })).toEqual(
      [{ type: 'text', text: 'Recorded evidence evidence-1 [sink] concatenation (edge edge-2).' }],
    )
    expect(render('codeaudit_add_finding', {}, {
      id: 'finding-1', title: 'sqli', severity: 'high', edgeIds: ['edge-5', 'edge-6'],
    })).toEqual(
      [{ type: 'text', text: 'Recorded finding finding-1 [high] sqli (edges edge-5, edge-6).' }],
    )
    expect(render('codeaudit_add_asset', {}, { id: 'asset-1', type: 'repo', value: 'shop-backend' })).toEqual(
      [{ type: 'text', text: 'Recorded asset asset-1 [repo] shop-backend.' }],
    )
    expect(render('codeaudit_add_asset', {}, { id: 'asset-2', type: 'file', value: 'src/A.java', edgeId: 'edge-2' })).toEqual(
      [{ type: 'text', text: 'Recorded asset asset-2 [file] src/A.java (parent edge edge-2).' }],
    )
    expect(render('codeaudit_submit', {}, { evidences: 1, assets: 2, findings: 3, evidenceIds: ['evidence-1'], assetIds: ['asset-1', 'asset-2'], findingIds: ['finding-1'] })).toEqual(
      [{ type: 'text', text: 'Submitted 1 evidences (evidence-1), 2 assets (asset-1, asset-2), and 3 findings (finding-1) to the parent session.' }],
    )
    expect(render('codeaudit_graph', {}, { graph: {} })).toEqual([{ type: 'text', text: '{}' }])
    expect(render('codeaudit_report', {}, { markdown: 'md' })).toEqual([{ type: 'text', text: 'md' }])
  })

  it('renders codeaudit_state for initialized, empty, and uninitialized views', async () => {
    const { render } = await codeauditHarness()
    const initialized = render('codeaudit_state', {}, {
      initialized: true, engagement: { id: 'engagement-1', target: 'shop-backend', objective: 'o', scope: '', stack: '' },
      intents: [{ id: 'intent-1', sessionId: SESSION_ID, title: 'trace order', detail: '' }],
      evidences: [{ id: 'evidence-1', sessionId: SESSION_ID, intentId: 'intent-1', kind: 'sink', location: 'src/A.java:1', detail: 'concatenation', snippet: '', confidence: 0.9 }],
      findings: [{ id: 'finding-1', sessionId: SESSION_ID, intentId: 'intent-1', title: 'sqli', severity: 'high', status: 'confirmed', cwe: '', description: '', location: 'a:1', snippet: '', fix: '', evidenceIds: ['evidence-1'] }],
      assets: [{ id: 'asset-1', sessionId: SESSION_ID, type: 'repo', value: 'shop-backend', meta: '' }],
      edges: [],
      counts: { intents: 1, evidences: 1, findings: 1, assets: 1 },
    }) as Array<{ text: string }>
    expect(initialized[0]!.text).toContain('1 intents, 1 evidences')
    expect(initialized[0]!.text).toContain('critical 0, high 1, medium 0, low 0, info 0; confirmed 1, suspected 0')
    expect(initialized[0]!.text).toContain('intent-1「trace order」')
    expect(initialized[0]!.text).toContain('evidence-1 [sink] src/A.java:1: concatenation')
    expect(initialized[0]!.text).toContain('finding-1 [high|confirmed] sqli')
    expect(initialized[0]!.text).toContain('asset-1 [repo] shop-backend')
    const empty = render('codeaudit_state', {}, {
      initialized: true, engagement: { id: 'engagement-1', target: 'shop-backend', objective: 'o', scope: '', stack: '' },
      intents: [], evidences: [], findings: [], assets: [], edges: [],
      counts: { intents: 0, evidences: 0, findings: 0, assets: 0 },
    }) as Array<{ text: string }>
    expect(empty[0]!.text).toContain('Intents: none.')
    const uninitialized = render('codeaudit_state', {}, {
      initialized: false, intents: [], evidences: [], findings: [], assets: [], edges: [],
      counts: { intents: 0, evidences: 0, findings: 0, assets: 0 },
    }) as Array<{ text: string }>
    expect(uninitialized[0]!.text).toBe('Not initialized. Call codeaudit_set_engagement with target and objective.')
  })
})

describe('tool result cards', () => {
  it('presents the read-only projections as titled generic cards, errors excluded', async () => {
    const { ctx } = await codeauditHarness()
    const content = [{ type: 'text' as const, text: 'md' }]
    const cards = [
      ['codeaudit_state', '代码审计状态'],
      ['codeaudit_graph', '代码审计图'],
      ['codeaudit_report', '代码审计报告'],
    ] as const
    for (const [name, title] of cards) {
      const tool = ctx.tools.get(name)
      expect(tool).toBeDefined()
      expect(tool!.presentResult?.({}, { content, isError: false })).toEqual({ card: 'generic', title, content })
      expect(tool!.presentResult?.({}, { content, isError: true })).toBeUndefined()
    }
  })
})

describe('plugin lifecycle', () => {
  it('disposes without an opened domain', async () => {
    const { ctx } = await codeauditHarness()
    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
  })

  it('closes the opened domain on dispose', async () => {
    const { ctx, facility, call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    expect(facility.get('codeaudit')).toBeDefined()
    await ctx.fiber.dispose()
    expect(facility.get('codeaudit')).toBeUndefined()
  })

  it('drains queued writes before closing the domain', async () => {
    const { ctx, call } = await codeauditHarness()
    await call('codeaudit_set_engagement', { target: 'shop-backend', objective: 'o' }, SESSION_ID)
    await call('codeaudit_add_intent', { engagementId: 'engagement-1', title: 'probe' }, SESSION_ID)
    const writes = Promise.all([
      call('codeaudit_add_evidence', { intentId: 'intent-1', detail: 'a' }, SESSION_ID),
      call('codeaudit_add_evidence', { intentId: 'intent-1', detail: 'b' }, SESSION_ID),
    ])
    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
    await expect(writes).resolves.toHaveLength(2)
  })

  it('contributes the protocol section to the assembled system prompt', async () => {
    const { ctx } = await codeauditHarness()
    const assembly = await ctx.systemPrompt.assemble()
    expect(renderPrompt(assembly)).toContain('你是代码审计指挥官（决策 agent）')
  })
})
