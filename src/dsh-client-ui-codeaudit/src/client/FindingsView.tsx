/**
 * FindingsView: the 漏洞发现 sub-tab of the 代码审计 view. Lists every
 * vulnerability finding of the engagement, worst severity first — severity and
 * confirmed/suspected badges, title, CWE, the code location, description, fix
 * suggestion, and the affected asset when linked. The 查看完整链路 button on
 * each card opens the FindingChainDrawer: the end-to-end vulnerability chain
 * from the engagement through the intent and every supporting evidence (with
 * frozen code snippets) down to the finding.
 */

import { useEffect, useState } from 'react'
import type { CodeauditProjection, CodeauditProjectionNode, CodeauditSeverity } from '../../../dsh-codeaudit/src/client.ts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { FindingChainDrawer } from './FindingChainDrawer.tsx'
import type { CodeauditKey } from './locales.ts'
import css from './FindingsView.module.css'

/** The finding-shaped member of the node union. */
type FindingNode = Extract<CodeauditProjectionNode, { kind: 'finding' }>

/** A right drawer over one finding's replayable HTTP-raw POC. */
function PocDrawer({
  finding,
  t,
  onClose,
}: {
  readonly finding: FindingNode
  readonly t: PropsLocale<'codeaudit'>['t']
  readonly onClose: () => void
}) {
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle')
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [onClose])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(finding.poc)
      setCopyState('done')
    } catch {
      setCopyState('failed')
    }
  }
  const download = () => {
    const blob = new Blob([finding.poc], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `poc-${finding.id}.txt`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className={css.pocLayer} data-testid="finding-poc-drawer">
      <button type="button" className={css.backdrop} aria-hidden="true" tabIndex={-1} onClick={onClose} />
      <aside className={css.pocDrawer} aria-label={t('finding.pocTitle')}>
        <header className={css.pocHeader}>
          <div className={css.pocHeaderText}>
            <p className={css.pocHintLine}>{t('finding.pocHint')}</p>
            <h3 className={css.pocTitle}>{finding.title}<span className={css.pocId}>{finding.id}</span></h3>
          </div>
          <button type="button" className={css.close} aria-label="关闭" onClick={onClose}>×</button>
        </header>
        {finding.poc === '' ? (
          <p className={css.pocEmpty} data-testid="finding-poc-empty">{t('finding.pocEmpty')}</p>
        ) : (
          <>
            <div className={css.pocActions}>
              <button type="button" className={css.pocAction} data-testid="finding-poc-copy" onClick={() => { void copy() }}>
                {t(copyState === 'done' ? 'finding.pocCopied' : 'finding.pocCopy')}
              </button>
              <button type="button" className={css.pocAction} data-testid="finding-poc-download" onClick={download}>
                {t('finding.pocDownload')}
              </button>
            </div>
            {copyState === 'failed' && <p className={css.pocError} role="status">{t('finding.pocCopyFailed')}</p>}
            <pre className={css.pocRaw} data-testid="finding-poc-raw">{finding.poc}</pre>
          </>
        )}
      </aside>
    </div>
  )
}

/** Severity badge label keys. */
const SEVERITY_LABELS: Record<CodeauditSeverity, CodeauditKey> = {
  critical: 'severity.critical',
  high: 'severity.high',
  medium: 'severity.medium',
  low: 'severity.low',
  info: 'severity.info',
}

/** Worst-first display order. */
const SEVERITY_ORDER: readonly CodeauditSeverity[] = ['critical', 'high', 'medium', 'low', 'info']

/** Narrow the projection nodes to findings, worst severity first. */
function findingsOf(projection: CodeauditProjection): Array<CodeauditProjectionNode & { kind: 'finding' }> {
  return projection.nodes
    .filter((node): node is CodeauditProjectionNode & { kind: 'finding' } => node.kind === 'finding')
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
}

/** Full props of the findings sub-tab. */
export interface FindingsViewProps {
  readonly codeaudit: CodeauditProjection
  readonly t: PropsLocale<'codeaudit'>['t']
}

export function FindingsView({ codeaudit, t }: FindingsViewProps) {
  const [chainFinding, setChainFinding] = useState<FindingNode | null>(null)
  const [pocFinding, setPocFinding] = useState<FindingNode | null>(null)
  const findings = findingsOf(codeaudit)
  if (findings.length === 0) {
    return <p className={css.empty} data-testid="codeaudit-findings-empty">{t('findings.empty')}</p>
  }
  return (
    <div className={css.wrap}>
      <ul className={css.list} data-testid="codeaudit-findings">
        {findings.map((finding) => {
          const asset = finding.affectedAssetId === undefined
            ? undefined
            : codeaudit.assets.find(candidate => candidate.id === finding.affectedAssetId)
          return (
            <li key={finding.id} className={css.finding} data-severity={finding.severity} data-testid="codeaudit-finding">
              <header className={css.header}>
                <span className={css.severity} data-severity={finding.severity}>{t(SEVERITY_LABELS[finding.severity])}</span>
                <span className={css.status} data-status={finding.status}>{t(finding.status === 'confirmed' ? 'status.confirmed' : 'status.suspected')}</span>
                <h4 className={css.title}>{finding.title}</h4>
                <span className={css.id}>{finding.id}</span>
              </header>
              {finding.description !== '' && <p className={css.description}>{finding.description}</p>}
              <code className={css.location} data-testid="codeaudit-finding-location">{finding.location}</code>
              <div className={css.meta}>
                {finding.cwe !== '' && <span className={css.cwe}>{t('finding.cwe')}: {finding.cwe}</span>}
                <span className={css.evidenceCount}>{t('finding.evidence')}: {finding.evidenceIds.length}</span>
                {asset !== undefined && <span className={css.asset}>{t('finding.affected')}: [{asset.type}] {asset.value}</span>}
              </div>
              {finding.fix !== '' && <p className={css.fix}>{t('report.fix')}: {finding.fix}</p>}
              {finding.snippet !== '' && <pre className={css.snippet} data-testid="codeaudit-finding-snippet">{finding.snippet}</pre>}
              <div className={css.actions}>
                <button
                  type="button"
                  className={css.chainButton}
                  data-testid="codeaudit-finding-chain"
                  onClick={() => { setChainFinding(finding) }}
                >
                  {t('finding.viewChain')}
                </button>
                <button
                  type="button"
                  className={css.chainButton}
                  data-testid="codeaudit-finding-poc"
                  onClick={() => { setPocFinding(finding) }}
                >
                  {t('finding.poc')}{finding.poc === '' ? '' : ' ●'}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {chainFinding !== null && (
        <FindingChainDrawer
          finding={chainFinding}
          codeaudit={codeaudit}
          t={t}
          onClose={() => { setChainFinding(null) }}
        />
      )}
      {pocFinding !== null && (
        <PocDrawer
          finding={pocFinding}
          t={t}
          onClose={() => { setPocFinding(null) }}
        />
      )}
    </div>
  )
}
