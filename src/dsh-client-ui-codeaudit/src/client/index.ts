/**
 * Code-audit surface plugin, browser half: the 代码审计 conversation-view tab.
 * Projection-mode surface — the live codeaudit state arrives through
 * `useProjection('codeaudit')` (seeded by the history tail page, updated by
 * session/projection frames), so this plugin owns no store, no refresh chain,
 * and no event listener.
 *
 * The tab is a per-session surface: the view entry registers only while the
 * CURRENT session is composed from the `codeaudit` agent preset (the sessions
 * list's per-row `agentPreset`). The projection-key presence is NOT a usable
 * signal: the session-projection registry is host-wide, so once any codeaudit
 * preset is mounted the `codeaudit` key exists (as `null`) in every session's
 * baseline. Sessions drive the entry — switching the current session (or
 * switching the session's preset in place) toggles the registration, and the
 * view ring re-reads its entries on every slots version bump.
 */
import type { ClientContext, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the conversation.view
// entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { CodeauditView } from './CodeauditView.tsx'
import { en, NS, zh, type CodeauditKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The codeaudit view tab copy. */
    codeaudit: CodeauditKey
  }
}

/** The current-session id carried by the sessions list snapshot. */
type CurrentSessionId = SessionListState['current']

/** The agent-preset id whose sessions carry the codeaudit capability. */
const CODEAUDIT_PRESET = 'codeaudit'

/**
 * Whether a session is composed from the codeaudit preset — the session itself
 * or any listed ancestor (subagents of a codeaudit session inherit its preset;
 * their own rows may or may not carry `agentPreset` on the wire).
 */
function isCodeauditSession(snapshot: SessionListState, id: string): boolean {
  let cursor: string | undefined = id
  const seen = new Set<string>()
  const byId = snapshot.byId as Readonly<Record<string, { agentPreset?: string; parentId?: string } | undefined>>
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    const row: { agentPreset?: string; parentId?: string } | undefined = byId[cursor]
    if (row?.agentPreset === CODEAUDIT_PRESET) return true
    cursor = row?.parentId
  }
  return false
}

/** Required services for the view registration and its copy. */
export const inject = ['slots', 'locale', 'sessions']

/** The sessions list snapshot store consumed by the sync loop. */
interface SessionsListStore {
  getSnapshot(): SessionListState
  subscribe(listener: () => void): () => void
}

/**
 * Client plugin body: the 代码审计 view tab over the codeaudit projection,
 * mounted per-session (registered while the current session — or a listed
 * ancestor — carries the `codeaudit` agent preset, disposed as soon as it does
 * not).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-codeaudit: dictionaries')
  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration.
  const t = ctx.locale.bind(NS)
  // The published client-runtime types model `list` as a plain accessor; the
  // runtime object is a snapshot store (read + subscribe).
  const sessions = { list: ctx.sessions.list as unknown as SessionsListStore }

  ctx.slots.inject('conversation.view', () => {
    let disposeEntry: (() => void) | undefined
    let sessionId: CurrentSessionId
    let sessionCodeaudit: boolean | undefined

    const sync = (): void => {
      const snapshot = sessions.list.getSnapshot()
      const current = snapshot.current
      const codeaudit = current === undefined ? undefined : isCodeauditSession(snapshot, current)
      if (current === sessionId && codeaudit === sessionCodeaudit) return
      disposeEntry?.()
      disposeEntry = undefined
      sessionId = current
      sessionCodeaudit = codeaudit
      if (current === undefined || codeaudit !== true) return
      disposeEntry = ctx.slots.register({
        name: 'conversation.view',
        id: 'codeaudit',
        order: 20,
        locale: NS,
        label: () => t('view.codeaudit'),
      }, CodeauditView)
    }

    sync()
    const offList = sessions.list.subscribe(sync)
    return () => {
      offList()
      disposeEntry?.()
    }
  })
}
