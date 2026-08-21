/**
 * Codeaudit apply acceptance: the per-session 代码审计 view registration. No
 * entry mounts until the CURRENT session is composed from the `codeaudit`
 * agent preset; the entry follows current-session switches and in-place preset
 * switches; the inject disposer removes every subscription and registration.
 */
import { describe, expect, it, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { CodeauditView } from '../src/client/CodeauditView.tsx'
import { NS, en, zh } from '../src/client/locales.ts'

/** One recorded view registration. */
interface RegisterCall {
  options: { name: string; id?: string; order?: number; locale?: string; label?: () => string }
  component: unknown
}

/** The locale service's dictionary-registration signature. */
type RegisterDictionary = (_ns: string, _dicts: { zh: Record<string, string>; en: Record<string, string> }) => () => undefined

/** The fake ctx effect's signature (runs the function, keeps its disposer). */
type RunEffect = (fn: () => () => void) => () => void

/** Driving harness: fake slots/locale/sessions services with manual notify. */
function boot(): {
  setCurrent(id: string | undefined): void
  setPreset(id: string, preset: string | undefined): void
  setParent(id: string, parentId: string | undefined): void
  touchList(): void
  disposeInjection(): void
  registeredIds(): string[]
  registerCalls(): RegisterCall[]
  listListeners(): number
  injectNames(): string[]
  effect: Mock<RunEffect>
  localeRegister: Mock<RegisterDictionary>
} {
  const listListeners = new Set<() => void>()
  const registerCalls: RegisterCall[] = []
  const registered = new Map<string, unknown>()
  const injectNames: string[] = []
  let current: string | undefined
  const byId = new Map<string, { agentPreset?: string; parentId?: string }>()
  let injectDispose: (() => void) | undefined

  const register = (options: RegisterCall['options'], component: unknown) => {
    registerCalls.push({ options, component })
    const id = options.id ?? ''
    registered.set(id, component)
    return () => { registered.delete(id) }
  }
  const inject = (name: string, callback: () => () => void) => {
    injectNames.push(name)
    injectDispose = callback()
    return () => { injectDispose?.() }
  }
  const localeRegister: Mock<RegisterDictionary> = vi.fn((_ns, _dicts) => () => undefined)
  const bind = vi.fn(() => (key: string) => key)
  const effect: Mock<RunEffect> = vi.fn(fn => fn())

  apply({
    slots: { inject, register },
    locale: { register: localeRegister, bind },
    effect,
    sessions: {
      list: {
        getSnapshot: () => ({
          current,
          byId: Object.fromEntries(byId),
        }),
        subscribe: (fn: () => void) => {
          listListeners.add(fn)
          return () => { listListeners.delete(fn) }
        },
      },
    },
  } as never)

  return {
    setCurrent(id) {
      current = id
      for (const fn of [...listListeners]) fn()
    },
    setPreset(id, preset) {
      const row: { agentPreset?: string; parentId?: string } = { ...byId.get(id) }
      if (preset === undefined) delete row.agentPreset
      else row.agentPreset = preset
      byId.set(id, row)
      for (const fn of [...listListeners]) fn()
    },
    setParent(id, parentId) {
      const row: { agentPreset?: string; parentId?: string } = { ...byId.get(id) }
      if (parentId === undefined) delete row.parentId
      else row.parentId = parentId
      byId.set(id, row)
      for (const fn of [...listListeners]) fn()
    },
    touchList() {
      for (const fn of [...listListeners]) fn()
    },
    disposeInjection() { injectDispose?.() },
    registeredIds: () => [...registered.keys()],
    registerCalls: () => registerCalls,
    listListeners: () => listListeners.size,
    injectNames: () => injectNames,
    effect,
    localeRegister,
  }
}

describe('codeaudit surface registration', () => {
  it('mounts the dictionaries and no entries until a codeaudit-preset session is current', () => {
    const h = boot()
    expect(h.effect).toHaveBeenCalledWith(expect.any(Function), 'ui-codeaudit: dictionaries')
    expect(h.localeRegister).toHaveBeenCalledTimes(1)
    const [ns, dictionaries] = h.localeRegister.mock.calls[0]!
    expect(ns).toBe(NS)
    expect(dictionaries.zh).toBe(zh)
    expect(dictionaries.en).toBe(en)
    expect(h.injectNames()).toEqual(['conversation.view'])
    expect(h.registeredIds()).toEqual([])

    h.setCurrent('s-a')
    expect(h.registeredIds()).toEqual([]) // listed session, no preset yet

    h.setPreset('s-a', 'standard')
    expect(h.registeredIds()).toEqual([]) // non-codeaudit preset: no tab

    h.setPreset('s-a', 'codeaudit')
    expect(h.registeredIds()).toEqual(['codeaudit'])
    expect(h.registerCalls()).toHaveLength(1)
    const viewCall = h.registerCalls()[0]!
    expect(viewCall.options).toMatchObject({ name: 'conversation.view', id: 'codeaudit', order: 20, locale: NS })
    expect(viewCall.options.label!()).toBe('view.codeaudit')
    expect(viewCall.component).toBe(CodeauditView)
  })

  it('tracks the current session and its agent preset', () => {
    const h = boot()
    h.setPreset('s-codeaudit', 'codeaudit')
    h.setCurrent('s-codeaudit')
    expect(h.registeredIds()).toEqual(['codeaudit'])

    h.setPreset('s-normal', 'standard')
    h.setCurrent('s-normal') // switch away: disposed
    expect(h.registeredIds()).toEqual([])

    h.setCurrent('s-codeaudit') // switch back: re-registered
    expect(h.registeredIds()).toEqual(['codeaudit'])
    expect(h.registerCalls()).toHaveLength(2)

    h.setPreset('s-codeaudit', 'standard') // in-place preset switch: disposed
    expect(h.registeredIds()).toEqual([])

    h.setPreset('s-codeaudit', 'codeaudit') // back again
    expect(h.registeredIds()).toEqual(['codeaudit'])
    expect(h.registerCalls()).toHaveLength(3)

    h.touchList() // same session, same preset: no re-registration
    expect(h.registerCalls()).toHaveLength(3)

    h.setCurrent('s-ghost') // current without a list row: nothing to watch
    expect(h.registeredIds()).toEqual([])

    h.setCurrent(undefined) // no current session
    expect(h.registeredIds()).toEqual([])
    expect(h.registerCalls()).toHaveLength(3)
  })

  it('mounts the tab for subagents of a codeaudit session and hides it for others', () => {
    const h = boot()
    // A subagent of a codeaudit session: its own row has no preset, but the
    // ancestor chain resolves to the codeaudit preset.
    h.setPreset('s-parent', 'codeaudit')
    h.setParent('s-child', 's-parent')
    h.setCurrent('s-child')
    expect(h.registeredIds()).toEqual(['codeaudit'])

    // Grandchildren resolve through the chain too.
    h.setParent('s-grandchild', 's-child')
    h.setCurrent('s-grandchild')
    expect(h.registeredIds()).toEqual(['codeaudit'])

    // A subagent under a standard session does not.
    h.setPreset('s-normal', 'standard')
    h.setParent('s-child-of-normal', 's-normal')
    h.setCurrent('s-child-of-normal')
    expect(h.registeredIds()).toEqual([])

    // A parent that switches its preset off hides its subagents.
    h.setPreset('s-parent', 'standard')
    h.setCurrent('s-child')
    expect(h.registeredIds()).toEqual([])
  })

  it('terminates on ancestor cycles', () => {
    const h = boot()
    h.setPreset('s-cyc', 'standard')
    h.setParent('s-cyc', 's-cyc')
    h.setCurrent('s-cyc')
    expect(h.registeredIds()).toEqual([])
  })

  it('the inject disposer removes every subscription and the entry', () => {
    const h = boot()
    h.setPreset('s-codeaudit', 'codeaudit')
    h.setCurrent('s-codeaudit')
    expect(h.registeredIds()).toEqual(['codeaudit'])
    expect(h.listListeners()).toBe(1)

    h.disposeInjection()
    expect(h.registeredIds()).toEqual([])
    expect(h.listListeners()).toBe(0)

    h.setPreset('s-codeaudit', 'standard') // no listener left: nothing re-registers
    h.setCurrent('s-normal')
    expect(h.registerCalls()).toHaveLength(1)
  })
})

describe('ui-codeaudit node half', () => {
  it('the node apply is an inert loader seat', async () => {
    expect(() => { nodeApply() }).not.toThrow()
    const ctx = new Context()
    await ctx.plugin({ name: 'ui-codeaudit-node', apply: nodeApply })
    await ctx.fiber.dispose()
  })
})
