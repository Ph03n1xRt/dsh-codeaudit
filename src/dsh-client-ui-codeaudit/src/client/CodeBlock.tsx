/**
 * CodeBlock: syntax-highlighted, frozen code/POC rendering. The highlight.js
 * "common" bundle covers the languages an audit meets in the wild and
 * auto-detects the snippet's language; the POC renders with the dedicated
 * `http` grammar. highlight.js escapes its input while producing markup, so
 * the generated HTML is safe to inject.
 */

import { useMemo } from 'react'
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

export interface CodeBlockProps {
  readonly code: string
  /** Fixed highlight language ('http' for POC raw); omit to auto-detect. */
  readonly language?: string
  readonly testId?: string
}

export function CodeBlock({ code, language, testId }: CodeBlockProps) {
  const html = useMemo(() => code === '' ? '' : highlightOf(code, language), [code, language])
  return (
    <pre className={css.block} data-testid={testId}>
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}
