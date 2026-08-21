/** Render, copy, and download the current codeaudit projection as Markdown.
 *
 * The client-side report mirrors the server's `codeaudit_report` structure
 * (executive summary, engagement info, exploration chain, findings with their
 * evidence chains and fix suggestions, asset inventory) through the locale
 * seat, so the Web panel shows the same document the model produces.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { CodeauditProjection, CodeauditProjectionNode, CodeauditSeverity } from '../../../dsh-codeaudit/src/client.ts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ReportView.module.css'

export interface ReportViewProps {
  readonly codeaudit: CodeauditProjection
  readonly t: PropsLocale<'codeaudit'>['t']
}

/** Worst-first display order. */
const SEVERITY_ORDER: readonly CodeauditSeverity[] = ['critical', 'high', 'medium', 'low', 'info']

function reportOf(codeaudit: CodeauditProjection, t: ReportViewProps['t']): string {
  if (codeaudit.engagement === null) return `# ${t('report.title')}\n\n${t('report.uninitialized')}\n`
  const engagement = codeaudit.engagement
  const findings = codeaudit.nodes
    .filter((node): node is CodeauditProjectionNode & { kind: 'finding' } => node.kind === 'finding')
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
  const severityCounts = Object.fromEntries(SEVERITY_ORDER.map(severity => [severity, 0])) as Record<CodeauditSeverity, number>
  for (const finding of findings) severityCounts[finding.severity] += 1
  const confirmed = findings.filter(finding => finding.status === 'confirmed').length

  const evidenceOf = (evidenceId: string): string => {
    const evidence = codeaudit.nodes.find(node => node.id === evidenceId && node.kind === 'evidence')
    if (evidence === undefined || evidence.kind !== 'evidence') return evidenceId
    return `${evidence.id} [${evidence.evidenceKind}]${evidence.location === '' ? '' : ` ${evidence.location}`} ${evidence.detail}`
  }

  const chain = codeaudit.nodes.map((node) => {
    const anchor = codeaudit.edges.find(edge => edge.targetId === node.id)
    const relation = anchor === undefined ? '' : ` (${anchor.kind} ${anchor.sourceId})`
    if (node.kind === 'intent') return `- ${t('kind.intent')} (${node.id}) ${node.title}${node.detail === '' ? '' : `: ${node.detail}`}${relation}`
    if (node.kind === 'evidence') return `- ${t('kind.evidence')} (${node.id}) [${node.evidenceKind}]${node.location === '' ? '' : ` ${node.location}: `}${node.detail}${relation}`
    return `- ${t('kind.finding')} (${node.id}) [${node.severity}|${node.status}] ${node.title}${relation}`
  })
  const findingSections = findings.flatMap((finding) => {
    const asset = finding.affectedAssetId === undefined ? undefined : codeaudit.assets.find(candidate => candidate.id === finding.affectedAssetId)
    return [
      `### ${finding.id} [${finding.severity}|${finding.status}] ${finding.title}`,
      `- ${t('report.description')}: ${finding.description === '' ? t('report.none') : finding.description}`,
      `- ${t('report.cwe')}: ${finding.cwe === '' ? t('report.unclassified') : finding.cwe}`,
      `- ${t('report.location')}: ${finding.location}`,
      `- ${t('finding.affected')}: ${asset === undefined ? t('report.unlinked') : `[${asset.type}] ${asset.value}`}`,
      `- ${t('report.fix')}: ${finding.fix === '' ? t('report.none') : finding.fix}`,
      ...(finding.poc === '' ? [] : [`- ${t('finding.poc')} (HTTP raw):`, ...finding.poc.split('\n').map(line => `  ${line}`)]),
      `- ${t('report.evidence')}:`,
      ...finding.evidenceIds.map((evidenceId, index) => `  ${index + 1}. ${evidenceOf(evidenceId)}`),
      '',
    ]
  })
  const assetLines = codeaudit.assets.map((asset) => {
    const edge = codeaudit.edges.find(candidate => candidate.kind === 'parent' && candidate.targetId === asset.id)
    const parent = edge === undefined ? undefined : codeaudit.assets.find(candidate => candidate.id === edge.sourceId)
    return `- [${asset.type}] ${asset.value}${asset.meta === '' ? '' : ` (${asset.meta})`}${parent === undefined ? '' : ` <- ${parent.value}`}`
  })
  return [
    `# ${t('report.title')}`,
    '',
    `## ${t('report.summary')}`,
    `- ${t('report.findingsTotal')}: ${findings.length} (confirmed ${confirmed} / suspected ${findings.length - confirmed})`,
    `- ${t('report.severityBreakdown')}: ${SEVERITY_ORDER.map(severity => `${severity} ${severityCounts[severity]}`).join(' / ')}`,
    `- ${t('counts', { intents: codeaudit.counts.intents, evidences: codeaudit.counts.evidences, findings: codeaudit.counts.findings, assets: codeaudit.counts.assets })}`,
    '',
    `## ${t('report.engagement')}`,
    `- ${t('report.target')}: ${engagement.target}`,
    `- ${t('report.objective')}: ${engagement.objective}`,
    `- ${t('report.scope')}: ${engagement.scope === '' ? t('report.undeclared') : engagement.scope}`,
    `- ${t('report.stack')}: ${engagement.stack === '' ? t('report.unrecorded') : engagement.stack}`,
    '',
    `## ${t('report.chain')}`,
    ...(chain.length === 0 ? [t('report.chainEmpty')] : chain),
    '',
    `## ${t('report.findings')}`,
    ...(findingSections.length === 0 ? [t('report.none')] : findingSections),
    `## ${t('report.assets')}`,
    ...(assetLines.length === 0 ? [t('report.none')] : assetLines),
    '',
  ].join('\n')
}

function filenameOf(target: string): string {
  const name = target.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `codeaudit-report-${name === '' ? 'session' : name}.md`
}

/** Render the report's small, fixed Markdown subset without interpreting HTML. */
function MarkdownPreview({ markdown }: { readonly markdown: string }) {
  const rows: ReactNode[] = []
  for (const [index, line] of markdown.split('\n').entries()) {
    if (line === '') continue
    if (line.startsWith('### ')) {
      rows.push(<h3 key={index}>{line.slice(4)}</h3>)
    } else if (line.startsWith('## ')) {
      rows.push(<h2 key={index}>{line.slice(3)}</h2>)
    } else if (line.startsWith('# ')) {
      rows.push(<h1 key={index}>{line.slice(2)}</h1>)
    } else if (line.startsWith('- ')) {
      rows.push(<p key={index} className={css.bullet}>{line.slice(2)}</p>)
    } else if (/^  \d+\. /.test(line)) {
      rows.push(<p key={index} className={css.step}>{line.trim()}</p>)
    } else {
      rows.push(<p key={index}>{line}</p>)
    }
  }
  return <article className={css.markdown} data-testid="codeaudit-report-markdown">{rows}</article>
}

export function ReportView({ codeaudit, t }: ReportViewProps) {
  const markdown = reportOf(codeaudit, t)
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopyState('done')
    } catch {
      setCopyState('failed')
    }
  }

  const download = () => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filenameOf(codeaudit.engagement?.target ?? '')
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className={css.root} data-testid="codeaudit-report">
      <header className={css.toolbar}>
        <p className={css.hint}>{t('report.hint')}</p>
        <div className={css.actions}>
          <button type="button" className={css.action} onClick={() => { void copy() }} data-testid="codeaudit-report-copy">
            {t(copyState === 'done' ? 'report.copied' : 'report.copy')}
          </button>
          <button type="button" className={css.action} onClick={download} data-testid="codeaudit-report-download">
            {t('report.download')}
          </button>
        </div>
      </header>
      {copyState === 'failed' && <p className={css.error} role="status">{t('report.copyFailed')}</p>}
      <MarkdownPreview markdown={markdown} />
    </section>
  )
}
