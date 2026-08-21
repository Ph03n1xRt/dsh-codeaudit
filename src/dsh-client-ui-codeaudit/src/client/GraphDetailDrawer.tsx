import { useEffect } from 'react'
import { CodeBlock } from './CodeBlock.tsx'
import css from './GraphDetailDrawer.module.css'

/** One labeled detail field; `mono` renders plain monospace, `code` highlights it. */
export interface GraphDetailField {
  readonly label: string
  readonly value: string
  /** Render in a plain monospace block (positions, asset values). */
  readonly mono?: boolean
  /** Render syntax-highlighted (code snippets). */
  readonly code?: boolean
}

export interface GraphDetailDrawerProps {
  readonly title: string
  readonly fields: readonly GraphDetailField[]
  readonly onClose: () => void
}

/** A graph-scoped right drawer that keeps complete node data available. */
export function GraphDetailDrawer({ title, fields, onClose }: GraphDetailDrawerProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [onClose])

  return (
    <div className={css.layer} data-testid="graph-detail-drawer">
      <button type="button" className={css.backdrop} aria-hidden="true" tabIndex={-1} onClick={onClose} />
      <aside className={css.drawer} aria-label="节点详情">
        <header className={css.header}>
          <h3 className={css.title}>{title}</h3>
          <button type="button" className={css.close} aria-label="关闭详情" onClick={onClose}>×</button>
        </header>
        <dl className={css.fields}>
          {fields.filter(field => field.value !== '').map(field => (
            <div key={field.label} className={css.field}>
              <dt>{field.label}</dt>
              {field.code === true
                ? <dd><CodeBlock code={field.value} /></dd>
                : field.mono === true
                  ? <dd><pre className={css.code}>{field.value}</pre></dd>
                  : <dd>{field.value}</dd>}
            </div>
          ))}
        </dl>
      </aside>
    </div>
  )
}
