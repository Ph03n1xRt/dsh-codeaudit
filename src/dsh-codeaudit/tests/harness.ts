/**
 * Shared test harness for the codeaudit plugin: a hand-built context carrying
 * the storage hub with an in-memory backend, the storage-domain facility, the
 * tool registry, the system-prompt service, and the codeaudit plugin itself.
 * Tool calls are executed directly against the registry for one session id.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MemoryStorageBackend } from './memory-backend.ts'
import * as Codeaudit from '../src/index.ts'

export interface CodeauditBench {
  readonly ctx: Context
  readonly facility: DomainFacility
  /** Execute one codeaudit tool as the given session's agent. */
  readonly call: (name: string, args: unknown, sessionId: string) => Promise<unknown>
  /** Execute one codeaudit tool with an agentless caller (non-agent rejection). */
  readonly callWithoutAgent: (name: string, args: unknown) => Promise<unknown>
  /** Execute one tool as a delegated child of the supplied parent session. */
  readonly callAsChild: (name: string, args: unknown, parentSessionId: string) => Promise<unknown>
  /** Execute one delegated-child tool call without creating its claimed parent. */
  readonly callAsChildWithoutParent: (name: string, args: unknown, parentSessionId: string) => Promise<unknown>
  /** Invoke one tool's model-visible render function directly. */
  readonly render: (name: string, args: unknown, value: unknown) => unknown
}

/** Boot the codeaudit plugin over the storage hub with an in-memory backend. */
export async function codeauditHarness(): Promise<CodeauditBench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(Codeaudit)
  const run = (name: string, args: unknown, agent?: { session: { id: string; header?: { parentSession?: string } } }): Promise<unknown> => {
    const tool = ctx.tools.get(name)
    if (tool === undefined) throw new Error(`tool '${name}' is not registered`)
    return tool.execute(args, { agent } as never)
  }
  return {
    ctx,
    facility,
    call: (name, args, sessionId) => run(name, args, { session: { id: sessionId } }),
    callWithoutAgent: (name, args) => run(name, args),
    callAsChild: (name, args, parentSessionId) => {
      if (ctx.sessions.get(parentSessionId as never) === undefined) ctx.sessions.create(parentSessionId as never)
      return run(name, args, { session: { id: 'child-session', header: { parentSession: parentSessionId } } })
    },
    callAsChildWithoutParent: (name, args, parentSessionId) =>
      run(name, args, { session: { id: 'child-session', header: { parentSession: parentSessionId } } }),
    render: (name, args, value) => {
      const tool = ctx.tools.get(name)
      if (tool === undefined) throw new Error(`tool '${name}' is not registered`)
      const output = tool.output as unknown as { render?: (args: unknown, value: unknown) => unknown }
      return output.render?.(args, value)
    },
  }
}

/** A fixed session id reused across one test. */
export const SESSION_ID = 'session-a'

/** Boot the codeaudit plugin plus the session-projection seam over one live session. */
export async function codeauditProjectionHarness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(Codeaudit)
  return { ctx, session: ctx.sessions.create() }
}
