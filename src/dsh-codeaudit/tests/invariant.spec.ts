/**
 * The codeaudit invariant companion: referential discipline on
 * `domain/changed` — every record references an existing engagement of the
 * codeaudit domain, every edge (including supports) references source/target
 * nodes of the exact kinds its kind demands within one session, and
 * engagements rows carry their own key as sessionId.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { type InvariantError } from '@deepseek-ai/dsh-invariants'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import * as Companion from '../../invariant.ts'
import { codeauditDomainSpec, type CodeauditEdge } from '../src/spec.ts'
import { MemoryStorageBackend } from './memory-backend.ts'

/** One well-formed edge of every kind for session s1. */
const edge = (kind: CodeauditEdge['kind'], sourceId: string, targetId: string): CodeauditEdge => ({
  id: `e-${kind}`, sessionId: 's1', kind, sourceId, targetId,
})

async function setup(open = true): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(Companion)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  if (open) {
    const domain = await facility.open(codeauditDomainSpec)
    await domain.table('engagements').put('s1', { id: 'engagement-1', sessionId: 's1', target: 'shop-backend', objective: 'o', scope: '', stack: '' })
    await domain.table('engagements').put('s9', { id: 'engagement-1', sessionId: 's9', target: 'other', objective: 'o', scope: '', stack: '' })
    await domain.table('intents').put('intent-1', { id: 'intent-1', sessionId: 's1', title: 'a', detail: '' })
    await domain.table('intents').put('intent-2', { id: 'intent-2', sessionId: 's1', title: 'b', detail: '' })
    await domain.table('intents').put('intent-9', { id: 'intent-9', sessionId: 's9', title: 'foreign', detail: '' })
    await domain.table('evidences').put('evidence-1', { id: 'evidence-1', sessionId: 's1', intentId: 'intent-1', kind: 'sink', location: 'a.java:1', detail: 'd', snippet: '', confidence: 1 })
    await domain.table('findings').put('finding-1', {
      id: 'finding-1', sessionId: 's1', intentId: 'intent-2', title: 'n', severity: 'high', status: 'confirmed',
      cwe: '', description: '', location: 'a.java:2', snippet: '', poc: '', pocNote: '', pocScript: '', fix: '', affectedAssetId: 'asset-1',
    })
    await domain.table('assets').put('asset-1', { id: 'asset-1', sessionId: 's1', type: 'repo', value: 'shop-backend', meta: '' })
    await domain.table('assets').put('asset-2', { id: 'asset-2', sessionId: 's1', type: 'module', value: 'order-service', meta: '' })
    await domain.table('assets').put('asset-9', { id: 'asset-9', sessionId: 's9', type: 'file', value: 'src/F.java', meta: '' })
    await domain.table('edges').put('e-spawns', edge('spawns', 'engagement-1', 'intent-1'))
    await domain.table('edges').put('e-yields', edge('yields', 'intent-1', 'evidence-1'))
    await domain.table('edges').put('e-derived', edge('derived_from', 'evidence-1', 'intent-2'))
    await domain.table('edges').put('e-proves', edge('proves', 'intent-2', 'finding-1'))
    await domain.table('edges').put('e-supports', edge('supports', 'evidence-1', 'finding-1'))
    await domain.table('edges').put('e-parent', edge('parent', 'asset-1', 'asset-2'))
  }
  return { ctx }
}

const invariantViolation = expect.objectContaining<Partial<InvariantError>>({
  code: 'INVARIANT',
  packageName: 'dsh-codeaudit',
})

function emit(ctx: Context, change: Omit<DomainChanged, 'domain'> & { domain?: string }): void {
  ctx.emit('domain/changed', { domain: 'codeaudit', ...change } as DomainChanged)
}

describe('codeaudit invariant companion', () => {
  it('accepts well-formed records of every codeaudit table', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, {
        table: 'engagements', key: 's2', operation: 'put',
        value: { id: 'engagement-1', sessionId: 's2', target: 't', objective: 'o', scope: '', stack: '' },
      })
    }).not.toThrow()
    expect(() => {
      emit(ctx, {
        table: 'intents', key: 'intent-3', operation: 'put',
        value: { id: 'intent-3', sessionId: 's1', title: 'c', detail: '' },
      })
    }).not.toThrow()
    expect(() => {
      emit(ctx, {
        table: 'edges', key: 'e-new', operation: 'put',
        value: edge('supports', 'evidence-1', 'finding-1'),
      })
    }).not.toThrow()
  })

  it('rejects an engagements row whose key does not match its sessionId', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, {
        table: 'engagements', key: 's2', operation: 'put',
        value: { id: 'engagement-1', sessionId: 's9', target: 't', objective: 'o', scope: '', stack: '' },
      })
    }).toThrow(invariantViolation)
  })

  it('rejects records referencing an unknown session', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, {
        table: 'intents', key: 'i-ghost', operation: 'put',
        value: { id: 'i-ghost', sessionId: 'ghost', title: 'a', detail: '' },
      })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, {
        table: 'edges', key: 'e-ghost', operation: 'put',
        value: { ...edge('spawns', 'engagement-1', 'intent-1'), sessionId: 'ghost' },
      })
    }).toThrow(invariantViolation)
  })

  it('rejects edges whose source is not the required node kind of the session', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('spawns', 'intent-1', 'intent-2') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('yields', 'evidence-1', 'evidence-1') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('derived_from', 'intent-1', 'intent-2') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('proves', 'evidence-1', 'finding-1') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('supports', 'intent-1', 'finding-1') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('parent', 'intent-1', 'asset-2') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('spawns', 'engagement-9', 'intent-1') })
    }).toThrow(invariantViolation)
  })

  it('rejects edges whose target is not the node kind the edge points at', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('spawns', 'engagement-1', 'evidence-1') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('proves', 'intent-2', 'intent-1') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('supports', 'evidence-1', 'intent-1') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('parent', 'asset-1', 'finding-1') })
    }).toThrow(invariantViolation)
  })

  it('rejects edges referencing nodes of another session', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('yields', 'intent-9', 'evidence-1') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('parent', 'asset-9', 'asset-2') })
    }).toThrow(invariantViolation)
  })

  it('rejects findings referencing an unknown or foreign-session asset', async () => {
    const { ctx } = await setup()
    const finding = (affectedAssetId?: string) => ({
      id: 'finding-2', sessionId: 's1', intentId: 'intent-2', title: 'n', severity: 'low', status: 'suspected',
      cwe: '', description: '', location: 'a.java:3', snippet: '', poc: '', pocNote: '', pocScript: '', fix: '',
      ...(affectedAssetId === undefined ? {} : { affectedAssetId }),
    })
    expect(() => {
      emit(ctx, { table: 'findings', key: 'finding-2', operation: 'put', value: finding('missing') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'findings', key: 'finding-2', operation: 'put', value: finding('asset-9') })
    }).toThrow(invariantViolation)
    // No affected asset is fine.
    expect(() => {
      emit(ctx, { table: 'findings', key: 'finding-2', operation: 'put', value: finding() })
    }).not.toThrow()
  })

  it('rejects a codeaudit event emitted while the domain is not open', async () => {
    const { ctx } = await setup(false)
    expect(() => {
      emit(ctx, {
        table: 'intents', key: 'i1', operation: 'put',
        value: { id: 'i1', sessionId: 's1', title: 'a', detail: '' },
      })
    }).toThrow(invariantViolation)
  })

  it('ignores deletions, events of other domains, and unknown codeaudit tables', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, { table: 'intents', key: 'i1', operation: 'deleted', value: {} })
    }).not.toThrow()
    expect(() => {
      emit(ctx, { table: 'mystery', key: 'm1', operation: 'put', value: {} })
    }).not.toThrow()
    ctx.emit('domain/changed', { domain: 'other', table: 'rows', key: 'a', operation: 'put', value: {} } as DomainChanged)
  })
})
