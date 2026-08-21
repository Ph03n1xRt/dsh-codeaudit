/**
 * CodeBlock: syntax-highlighted, frozen code/POC rendering. The highlight.js
 * "common" bundle covers the languages an audit meets in the wild and
 * auto-detects the snippet's language; the POC renders with the dedicated
 * `http` grammar. The copy button is highlightjs-copy's themed plugin button
 * (inherits the panel colors through --hljs-theme-* variables), so its look
 * is the plugin's, not hand-rolled CSS.
 */

import { useEffect, useRef } from 'react'
import hljs from 'highlight.js/lib/common'
import http from 'highlight.js/lib/languages/http'
import CopyButtonPlugin from 'highlightjs-copy'
// Global class names (.hljs-copy-*): rides the raw-CSS inline channel.
import 'highlightjs-copy/dist/highlightjs-copy.min.css'
// The github-dark theme for the code surface itself (global .hljs-* names).
import 'highlight.js/styles/github-dark.css'
import css from './CodeBlock.module.css'

hljs.registerLanguage('http', http)
let pluginRegistered = false
/** Register the copy plugin on first use — its constructor reads `document`
 * (for <html lang>), so this must not run at module load in node contexts. */
function ensureCopyPlugin(): void {
  if (pluginRegistered) return
  hljs.addPlugin(new CopyButtonPlugin())
  pluginRegistered = true
}

export interface CodeBlockProps {
  readonly code: string
  /** Fixed highlight language ('http' for POC raw); omit to auto-detect. */
  readonly language?: string
  readonly testId?: string
}

export function CodeBlock({ code, language, testId }: CodeBlockProps) {
  const codeRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = codeRef.current
    if (el === null || code === '') return
    ensureCopyPlugin()
    // Re-highlight on content change: reset the element, let highlight.js
    // (and the copy plugin, via its after:highlightElement hook) rebuild.
    el.textContent = code
    el.removeAttribute('data-highlighted')
    if (language !== undefined) el.dataset.langHint = language
    hljs.highlightElement(el)
  }, [code, language])
  return (
    <pre className={css.block} data-testid={testId}>
      <code ref={codeRef} className="hljs" />
    </pre>
  )
}
