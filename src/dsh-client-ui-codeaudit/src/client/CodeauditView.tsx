/**
 * CodeauditView: the 代码审计 conversation-view tab. A pure projection-mode
 * surface — the standing `codeaudit` projection (engagement plus the audit
 * graph) arrives through `useProjection('codeaudit')`, so the tab owns no
 * store and needs no host RPC. The view renders one engagement header card
 * (target, objective, scope, stack, node counts) over a sub-tab bar:
 * 探索链路 (the chain as an interactive graph, with each finding's evidence
 * chain drawn inline), 漏洞发现 (findings with per-finding full-chain
 * drill-down and frozen code snippets), 代码资产 (list or graph), and 报告
 * (copyable Markdown). Absent projection (capability or session not composed)
 * or null (no `codeaudit_set_engagement` yet) renders the guiding empty note.
 */

import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `codeaudit` SessionProjectionMap key merge.
import type {} from '../../../dsh-codeaudit/src/client.ts'
import { AssetsView } from './AssetsView.tsx'
import { ExploreView } from './ExploreView.tsx'
import { FindingsView } from './FindingsView.tsx'
import { ReportView } from './ReportView.tsx'
import type { CodeauditKey } from './locales.ts'
import css from './CodeauditView.module.css'

/** The four sub-tabs of the view. */
const TABS = ['explore', 'findings', 'assets', 'report'] as const

/** One sub-tab key. */
type ViewTab = typeof TABS[number]

/** Sub-tab label keys. */
const TAB_LABELS = {
  explore: 'view.tab.explore',
  findings: 'view.tab.findings',
  assets: 'view.tab.assets',
  report: 'view.tab.report',
} as const satisfies Record<ViewTab, CodeauditKey>

/** Full props of the view entry: session standard kit + the locale seat. */
export type CodeauditViewProps = PropsRuntime<'conversation.view'> & PropsLocale<'codeaudit'>

/** yak-skill availability chip from the host skills-status route; hidden when
 * the route is absent (older host) or the skill is installed. */
function YakSkillStatus({ t }: { readonly t: PropsLocale<'codeaudit'>['t'] }) {
  const [state, setState] = useState<'unknown' | 'missing' | 'busy'>('unknown')
  useEffect(() => {
    let cancelled = false
    const query = typeof fetch === 'function'
      ? fetch('/codeaudit/skills').then(response => (response.ok ? response.json() as Promise<{ yak?: boolean }> : undefined))
      : Promise.resolve(undefined)
    void query
      .then(payload => { if (!cancelled) setState(payload?.yak === true ? 'unknown' : 'missing') })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  if (state === 'unknown') return null
  const fetchSkill = async () => {
    setState('busy')
    try {
      const response = await fetch('/codeaudit/skills', { method: 'POST' })
      const payload = await response.json() as { yak?: boolean }
      setState(payload.yak === true ? 'unknown' : 'missing')
    } catch {
      setState('missing')
    }
  }
  return (
    <p className={css.skillStatus} data-testid="codeaudit-yak-skill">
      <span className={css.skillDot} data-state={state} aria-hidden="true" />
      {state === 'busy' ? t('skills.yak.fetching') : t('skills.yak.missing')}
      {state === 'missing' && (
        <button type="button" className={css.skillFetch} data-testid="codeaudit-yak-skill-fetch" onClick={() => { void fetchSkill() }}>
          {t('skills.yak.fetch')}
        </button>
      )}
    </p>
  )
}

export function CodeauditView({ useProjection, t }: CodeauditViewProps) {
  const codeaudit = useProjection('codeaudit')
  const [tab, setTab] = useState<ViewTab>('explore')
  if (codeaudit === undefined || codeaudit === null) {
    return (
      <div className={css.empty} data-testid="codeaudit-view">
        <span className={css.emptyText}>{t('view.empty')}</span>
      </div>
    )
  }
  return (
    <section className={css.root} data-testid="codeaudit-view">
      <header className={css.card}>
        <div className={css.cardTitle}>
          <h2 className={css.target}>{codeaudit.engagement === null ? '' : codeaudit.engagement.target}</h2>
          {codeaudit.engagement !== null && codeaudit.engagement.objective !== '' && (
            <span className={css.objective}>审计目标：{codeaudit.engagement.objective}</span>
          )}
        </div>
        <p className={css.counts}>
          {t('counts', {
            intents: codeaudit.counts.intents,
            evidences: codeaudit.counts.evidences,
            findings: codeaudit.counts.findings,
            assets: codeaudit.counts.assets,
          })}
        </p>
        {codeaudit.engagement !== null && codeaudit.engagement.scope !== '' && (
          <p className={css.metaLine}>范围：{codeaudit.engagement.scope}</p>
        )}
        {codeaudit.engagement !== null && codeaudit.engagement.stack !== '' && (
          <p className={css.metaLine}>技术栈：{codeaudit.engagement.stack}</p>
        )}
        <YakSkillStatus t={t} />
      </header>
      <nav className={css.tabs} data-testid="codeaudit-tabs">
        {TABS.map(tabKey => (
          <button
            key={tabKey}
            type="button"
            className={css.tab}
            aria-pressed={tab === tabKey}
            data-testid={`codeaudit-tab-${tabKey}`}
            onClick={() => { setTab(tabKey) }}
          >
            {t(TAB_LABELS[tabKey])}
            {tabKey === 'findings' ? ` (${codeaudit.counts.findings})` : ''}
            {tabKey === 'assets' ? ` (${codeaudit.counts.assets})` : ''}
          </button>
        ))}
      </nav>
      <div className={css.content}>
        {tab === 'explore' && <ExploreView codeaudit={codeaudit} t={t} />}
        {tab === 'findings' && <FindingsView codeaudit={codeaudit} t={t} />}
        {tab === 'assets' && <AssetsView codeaudit={codeaudit} t={t} />}
        {tab === 'report' && <ReportView codeaudit={codeaudit} t={t} />}
      </div>
    </section>
  )
}
