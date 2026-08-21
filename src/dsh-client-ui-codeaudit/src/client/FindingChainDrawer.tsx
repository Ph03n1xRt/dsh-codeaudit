/**
 * FindingChainDrawer: the per-finding full vulnerability-chain drill-down
 * (完整漏洞链路). A vertical stepper from the engagement through the proving
 * intent and every supporting evidence (in submission order, each with its
 * kind badge, file:line location, and the frozen code snippet) down to the
 * finding itself. The chain comes straight from the standing projection —
 * the finding's evidenceIds plus the intent reference — so it works on
 * replayed history with no storage access.
 */

import { useEffect } from 'react'
import type {
  CodeauditProjection,
  CodeauditProjectionNode,
} from '../../../dsh-codeaudit/src/client.ts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { CodeBlock } from './CodeBlock.tsx'
import type { CodeauditKey } from './locales.ts'
import css from './FindingChainDrawer.module.css'

/** The finding-shaped member of the node union. */
type FindingNode = Extract<CodeauditProjectionNode, { kind: 'finding' }>
/** The evidence-shaped member of the node union. */
type EvidenceNode = Extract<CodeauditProjectionNode, { kind: 'evidence' }>

/** Severity badge label keys. */
const SEVERITY_LABELS: Record<FindingNode['severity'], CodeauditKey> = {
  critical: 'severity.critical',
  high: 'severity.high',
  medium: 'severity.medium',
  low: 'severity.low',
  info: 'severity.info',
}

/** Evidence-kind badge label keys. */
const EVIDENCE_KIND_LABELS: Record<EvidenceNode['evidenceKind'], CodeauditKey> = {
  entry: 'evidence.kind.entry',
  sink: 'evidence.kind.sink',
  dataflow: 'evidence.kind.dataflow',
  sanitizer: 'evidence.kind.sanitizer',
  config: 'evidence.kind.config',
  dependency: 'evidence.kind.dependency',
  info: 'evidence.kind.info',
}

export interface FindingChainDrawerProps {
  /** The finding whose chain is shown. */
  readonly finding: FindingNode
  /** The standing projection the chain resolves against. */
  readonly codeaudit: CodeauditProjection
  readonly t: PropsLocale<'codeaudit'>['t']
  readonly onClose: () => void
}

/** One chain step card: a step label over free content. */
function Step({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <li className={css.step}>
      <span className={css.stepLabel}>{label}</span>
      <div className={css.stepBody}>{children}</div>
    </li>
  )
}

/** One evidence card of the chain: badges, location, detail, frozen snippet. */
function EvidenceCard({
  evidence,
  t,
}: {
  readonly evidence: EvidenceNode
  readonly t: PropsLocale<'codeaudit'>['t']
}) {
  return (
    <div className={css.evidence} data-kind={evidence.evidenceKind} data-testid="chain-evidence">
      <header className={css.evidenceHeader}>
        <span className={css.evidenceKind} data-kind={evidence.evidenceKind}>{t(EVIDENCE_KIND_LABELS[evidence.evidenceKind])}</span>
        <span className={css.evidenceId}>{evidence.id}</span>
        {evidence.location !== '' && <code className={css.evidenceLocation}>{evidence.location}</code>}
      </header>
      <p className={css.evidenceDetail}>{evidence.detail}</p>
      {evidence.snippet !== '' && <CodeBlock code={evidence.snippet} testId="chain-evidence-snippet" />}
    </div>
  )
}

export function FindingChainDrawer({ finding, codeaudit, t, onClose }: FindingChainDrawerProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [onClose])

  const intent = codeaudit.nodes.find((node): node is Extract<CodeauditProjectionNode, { kind: 'intent' }> =>
    node.id === finding.intentId && node.kind === 'intent')
  const evidences = finding.evidenceIds
    .map(id => codeaudit.nodes.find(node => node.id === id && node.kind === 'evidence'))
    .filter((node): node is EvidenceNode => node !== undefined)
  const asset = finding.affectedAssetId === undefined
    ? undefined
    : codeaudit.assets.find(candidate => candidate.id === finding.affectedAssetId)

  return (
    <div className={css.layer} data-testid="finding-chain-drawer">
      <button type="button" className={css.backdrop} aria-hidden="true" tabIndex={-1} onClick={onClose} />
      <aside className={css.drawer} aria-label={t('finding.chain')}>
        <header className={css.header}>
          <div className={css.headerText}>
            <p className={css.headerKicker}>{t('finding.chain')}</p>
            <h3 className={css.title}>
              <span className={css.severity} data-severity={finding.severity}>{t(SEVERITY_LABELS[finding.severity])}</span>
              <span className={css.status} data-status={finding.status}>{t(finding.status === 'confirmed' ? 'status.confirmed' : 'status.suspected')}</span>
              {finding.title}
            </h3>
          </div>
          <button type="button" className={css.close} aria-label="关闭详情" onClick={onClose}>×</button>
        </header>
        <ol className={css.steps}>
          {codeaudit.engagement !== null && (
            <Step label={t('chain.engagement')}>
              <p className={css.plainText}>
                {codeaudit.engagement.target}
                {codeaudit.engagement.objective === '' ? '' : ` — ${codeaudit.engagement.objective}`}
              </p>
            </Step>
          )}
          {intent !== undefined && (
            <Step label={t('chain.intent')}>
              <p className={css.plainText}>
                {intent.id}「{intent.title}」{intent.detail === '' ? '' : ` — ${intent.detail}`}
              </p>
            </Step>
          )}
          {evidences.length > 0 && (
            <Step label={t('chain.evidence')}>
              <div className={css.evidenceList}>
                {evidences.map(evidence => <EvidenceCard key={evidence.id} evidence={evidence} t={t} />)}
              </div>
            </Step>
          )}
          <Step label={t('chain.finding')}>
            <div className={css.findingCard}>
              {finding.description !== '' && <p className={css.plainText}>{finding.description}</p>}
              <dl className={css.findingFields}>
                <div className={css.field}>
                  <dt>{t('report.location')}</dt>
                  <dd><code className={css.evidenceLocation}>{finding.location}</code></dd>
                </div>
                {finding.cwe !== '' && (
                  <div className={css.field}>
                    <dt>{t('report.cwe')}</dt>
                    <dd>{finding.cwe}</dd>
                  </div>
                )}
                {asset !== undefined && (
                  <div className={css.field}>
                    <dt>{t('finding.affected')}</dt>
                    <dd>[{asset.type}] {asset.value}</dd>
                  </div>
                )}
                {finding.fix !== '' && (
                  <div className={css.field}>
                    <dt>{t('report.fix')}</dt>
                    <dd>{finding.fix}</dd>
                  </div>
                )}
              </dl>
              {finding.snippet !== '' && <CodeBlock code={finding.snippet} testId="chain-finding-snippet" />}
            </div>
          </Step>
        </ol>
      </aside>
    </div>
  )
}
