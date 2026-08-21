/**
 * FindingsView: the 漏洞发现 sub-tab of the 代码审计 view. Lists every
 * vulnerability finding of the engagement, worst severity first — severity and
 * confirmed/suspected badges, title, CWE, the code location, description, fix
 * suggestion, and the affected asset when linked. The 查看完整链路 button on
 * each card opens the FindingChainDrawer: the end-to-end vulnerability chain
 * from the engagement through the intent and every supporting evidence (with
 * frozen code snippets) down to the finding.
 */

import { useState } from 'react'
import type { CodeauditProjection, CodeauditProjectionNode, CodeauditSeverity } from '../../../dsh-codeaudit/src/client.ts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { FindingChainDrawer } from './FindingChainDrawer.tsx'
import type { CodeauditKey } from './locales.ts'
import css from './FindingsView.module.css'

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
  const [chainFinding, setChainFinding] = useState<(CodeauditProjectionNode & { kind: 'finding' }) | null>(null)
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
              <button
                type="button"
                className={css.chainButton}
                data-testid="codeaudit-finding-chain"
                onClick={() => { setChainFinding(finding) }}
              >
                {t('finding.viewChain')}
              </button>
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
    </div>
  )
}
