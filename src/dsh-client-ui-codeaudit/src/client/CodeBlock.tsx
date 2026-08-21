/**
 * CodeBlock: syntax-highlighted, frozen code/POC rendering. The highlight.js
 * "common" bundle covers the languages an audit meets in the wild and
 * auto-detects the snippet's language; the POC renders with the dedicated
 * `http` grammar. highlight.js escapes its input while producing markup, so
 * the generated HTML is safe to inject.
 *
 * `copy`/`download` mount quiet action buttons in the block's top-right
 * corner — the single place copy affordances live across the panel.
 */

import { useMemo, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import http from 'highlight.js/lib/languages/http'
// Global class names (.hljs-*): rides the raw-CSS inline channel.
import 'highlight.js/styles/github-dark.css'
import css from './CodeBlock.module.css'

hljs.registerLanguage('http', http)

/** Highlight one payload: fixed language when given, auto-detect otherwise. */
function highlightOf(code: string, language: string | undefined): string {
  try {
    if (language !== undefined) return hljs.highlight(code, { language, ignoreIllegals: true }).value
    return hljs.highlightAuto(code).value
  } catch {
    return code
  }
}

/** Minimal copy-button copy (zh-first; the panel's locale is not threaded here). */
export interface CodeBlockCopyLabels {
  readonly copy: string
  readonly copied: string
  readonly failed: string
}

export interface CodeBlockProps {
  readonly code: string
  /** Fixed highlight language ('http' for POC raw); omit to auto-detect. */
  readonly language?: string
  readonly testId?: string
  /** Show the top-right copy button with these labels. */
  readonly copy?: CodeBlockCopyLabels
  /** Also offer a download for this filename (top-right, next to copy). */
  readonly download?: string
  /** Stable test ids for the action buttons (defaults: codeblock-copy/download). */
  readonly copyTestId?: string
  readonly downloadTestId?: string
}

export function CodeBlock({ code, language, testId, copy, download, copyTestId = 'codeblock-copy', downloadTestId = 'codeblock-download' }: CodeBlockProps) {
  const html = useMemo(() => code === '' ? '' : highlightOf(code, language), [code, language])
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setState('done')
    } catch {
      setState('failed')
    }
    window.setTimeout(() => { setState('idle') }, 1600)
  }
  const onDownload = () => {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = download ?? 'snippet.txt'
    link.click()
    URL.revokeObjectURL(url)
  }

  const hasActions = copy !== undefined || download !== undefined
  return (
    <div className={css.wrap}>
      {hasActions && (
        <div className={css.actions}>
          {copy !== undefined && (
            <button
              type="button"
              className={css.action}
              data-state={state === 'idle' ? undefined : state}
              data-testid={copyTestId}
              onClick={() => { void onCopy() }}
            >
              {state === 'done' ? copy.copied : state === 'failed' ? copy.failed : copy.copy}
            </button>
          )}
          {download !== undefined && (
            <button type="button" className={css.action} data-testid={downloadTestId} onClick={onDownload}>
              .txt
            </button>
          )}
        </div>
      )}
      <pre className={css.block} data-testid={testId}>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}
