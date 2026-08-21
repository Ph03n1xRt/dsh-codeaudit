// @vitest-environment jsdom
/**
 * Codeaudit sub-tab acceptance: the 代码审计 view entry (guiding empty note for
 * absent/null projection; the engagement header card; the sub-tab bar), the
 * 漏洞发现 list (severity/status badges, code location, frozen snippet, and
 * the per-finding full-chain drawer with evidence snippets), and the 报告 tab
 * (executive summary, evidence chains, fix suggestions).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeauditProjection } from '../../dsh-codeaudit/src/client.ts'
import { CodeauditView, type CodeauditViewProps } from '../src/client/CodeauditView.tsx'
import { ExploreView } from '../src/client/ExploreView.tsx'
import { FindingsView } from '../src/client/FindingsView.tsx'
import { zh } from '../src/client/locales.ts'

/** A local translate over the zh dictionary (params interpolated as {name}). */
const t = ((key: string, params?: Record<string, string | number>) => {
  let text: string = (zh as Record<string, string>)[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}) as CodeauditViewProps['t']

/** jsdom has no ResizeObserver; the React Flow graphs measure through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const ENGAGEMENT = { id: 'engagement-1', target: 'shop-backend', objective: 'audit injection and authz', scope: 'src/main only', stack: 'Java/Spring' }

const STANDING: CodeauditProjection = {
  engagement: ENGAGEMENT,
  nodes: [
    { id: 'intent-1', kind: 'intent', title: 'trace /api/order params', detail: 'source → sink' },
    { id: 'evidence-1', kind: 'evidence', evidenceKind: 'entry', intentId: 'intent-1', location: 'src/OrderController.java:42', detail: 'q reaches DAO unencoded', snippet: 'public List<Order> find(@RequestParam String q) {', confidence: 0.9 },
    { id: 'evidence-2', kind: 'evidence', evidenceKind: 'sink', intentId: 'intent-1', location: 'src/OrderDao.java:87', detail: 'query built by string concatenation', snippet: 'return jdbc.query("... where name = \'" + q + "\'");', confidence: 0.9 },
    { id: 'finding-1', kind: 'finding', intentId: 'intent-1', title: 'SQL injection in OrderDao.findByUser', severity: 'high', status: 'confirmed', cwe: 'CWE-89', description: 'Injectable parameter', location: 'src/OrderDao.java:87', snippet: 'return jdbc.query("..." + q);', poc: 'POST /api/order HTTP/1.1\nHost: shop.example.com\nContent-Type: application/x-www-form-urlencoded\n\nq=1%27+OR+%271%27%3D%271', fix: 'Use a parameterized query', evidenceIds: ['evidence-1', 'evidence-2'], affectedAssetId: undefined },
  ],
  assets: [
    { id: 'asset-1', type: 'repo', value: 'shop-backend', meta: '' },
  ],
  edges: [
    { id: 'edge-1', kind: 'spawns', sourceId: 'engagement-1', targetId: 'intent-1' },
    { id: 'edge-2', kind: 'yields', sourceId: 'intent-1', targetId: 'evidence-1' },
    { id: 'edge-3', kind: 'yields', sourceId: 'intent-1', targetId: 'evidence-2' },
    { id: 'edge-4', kind: 'proves', sourceId: 'intent-1', targetId: 'finding-1' },
    { id: 'edge-5', kind: 'supports', sourceId: 'evidence-1', targetId: 'finding-1' },
    { id: 'edge-6', kind: 'supports', sourceId: 'evidence-2', targetId: 'finding-1' },
  ],
  counts: { intents: 1, evidences: 2, findings: 1, assets: 1 },
}

/** View props stub: the view reads the 'codeaudit' projection only; the session standard kit stays unused. */
function viewProps(projection: CodeauditProjection | null | undefined): CodeauditViewProps {
  const useProjection = () => projection
  return { useProjection: useProjection as CodeauditViewProps['useProjection'], t } as unknown as CodeauditViewProps
}

describe('CodeauditView', () => {
  it('renders the guiding empty note for absent and null projections', () => {
    const { rerender } = render(<CodeauditView {...viewProps(undefined)} />)
    expect(screen.getByTestId('codeaudit-view').textContent).toContain(zh['view.empty'])
    rerender(<CodeauditView {...viewProps(null)} />)
    expect(screen.getByTestId('codeaudit-view').textContent).toContain(zh['view.empty'])
  })

  it('renders the engagement header card and the sub-tab bar, then switches tabs', () => {
    render(<CodeauditView {...viewProps(STANDING)} />)
    const header = screen.getByTestId('codeaudit-view')
    expect(header.textContent).toContain('shop-backend')
    expect(header.textContent).toContain('audit injection and authz')
    expect(header.textContent).toContain('src/main only')
    expect(header.textContent).toContain('Java/Spring')
    expect(screen.getByTestId('codeaudit-tab-findings').textContent).toContain('漏洞发现 (1)')
    expect(screen.getByTestId('codeaudit-tab-assets').textContent).toContain('代码资产 (1)')
    fireEvent.click(screen.getByTestId('codeaudit-tab-findings'))
    expect(screen.getByTestId('codeaudit-finding')).toBeDefined()
    fireEvent.click(screen.getByTestId('codeaudit-tab-assets'))
    expect(screen.getByTestId('codeaudit-asset-row')).toBeDefined()
  })
})

describe('FindingsView', () => {
  it('lists findings with severity/status badges, location, snippet, and the evidence count', () => {
    render(<FindingsView codeaudit={STANDING} t={t} />)
    const finding = screen.getByTestId('codeaudit-finding')
    expect(finding.textContent).toContain('SQL injection in OrderDao.findByUser')
    expect(finding.textContent).toContain('高危')
    expect(finding.textContent).toContain('已确认')
    expect(finding.textContent).toContain('CWE-89')
    expect(finding.textContent).toContain('修复建议: Use a parameterized query')
    expect(screen.getByTestId('codeaudit-finding-location').textContent).toBe('src/OrderDao.java:87')
    expect(screen.getByTestId('codeaudit-finding-snippet').textContent).toContain('jdbc.query')
    expect(finding.textContent).toContain('证据链: 2')
  })

  it('renders the empty note without findings', () => {
    const empty: CodeauditProjection = { ...STANDING, nodes: STANDING.nodes.filter((node: CodeauditProjection['nodes'][number]) => node.kind !== 'finding'), counts: { intents: 1, evidences: 2, findings: 0, assets: 1 } }
    render(<FindingsView codeaudit={empty} t={t} />)
    expect(screen.getByTestId('codeaudit-findings-empty').textContent).toBe(zh['findings.empty'])
  })

  it('opens the full vulnerability-chain drawer with every evidence and its frozen snippet', () => {
    render(<FindingsView codeaudit={STANDING} t={t} />)
    fireEvent.click(screen.getByTestId('codeaudit-finding-chain'))
    const drawer = screen.getByTestId('finding-chain-drawer')
    // The end-to-end chain: engagement → intent → evidences (in evidenceIds order) → finding.
    expect(drawer.textContent).toContain('完整漏洞链路')
    expect(drawer.textContent).toContain('审计任务')
    expect(drawer.textContent).toContain('trace /api/order params')
    expect(drawer.textContent).toContain('q reaches DAO unencoded')
    expect(drawer.textContent).toContain('query built by string concatenation')
    expect(drawer.textContent).toContain('SQL injection in OrderDao.findByUser')
    // Both frozen evidence snippets render in the chain.
    const evidenceSnippets = screen.getAllByTestId('chain-evidence-snippet')
    expect(evidenceSnippets).toHaveLength(2)
    expect(evidenceSnippets[0]!.textContent).toContain('@RequestParam String q')
    expect(evidenceSnippets[1]!.textContent).toContain('jdbc.query')
    // The finding's own snippet and fix render too.
    expect(screen.getByTestId('chain-finding-snippet').textContent).toContain('jdbc.query')
    expect(drawer.textContent).toContain('Use a parameterized query')
    // Escape closes the drawer.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('finding-chain-drawer')).toBeNull()
  })

  it('orders findings worst severity first and distinguishes suspected status', () => {
    const medium: CodeauditProjection = {
      ...STANDING,
      nodes: [
        ...STANDING.nodes,
        { id: 'finding-2', kind: 'finding', intentId: 'intent-1', title: 'verbose error leakage', severity: 'medium', status: 'suspected', cwe: 'CWE-209', description: '', location: 'src/Err.java:9', snippet: '', poc: '', fix: '', evidenceIds: ['evidence-1'], affectedAssetId: undefined },
      ],
      counts: { intents: 1, evidences: 2, findings: 2, assets: 1 },
    }
    render(<FindingsView codeaudit={medium} t={t} />)
    const findings = screen.getAllByTestId('codeaudit-finding')
    expect(findings[0]!.textContent).toContain('SQL injection')
    expect(findings[1]!.textContent).toContain('verbose error leakage')
    expect(findings[1]!.textContent).toContain('存疑')
  })
})

describe('ExploreView', () => {
  /** The standing chain plus one dead-end intent that never proved a finding. */
  function withDeadEnd(): CodeauditProjection {
    return {
      ...STANDING,
      nodes: [
        ...STANDING.nodes,
        { id: 'intent-9', kind: 'intent', title: 'dead-end recon', detail: '' },
      ],
      edges: [
        ...STANDING.edges,
        { id: 'edge-7', kind: 'spawns', sourceId: 'engagement-1', targetId: 'intent-9' },
      ],
    }
  }

  it('renders the toolbar and drops dead-end branches under 仅漏洞链路', () => {
    render(<ExploreView codeaudit={withDeadEnd()} t={t} />)
    expect(screen.getByTestId('codeaudit-explore-toolbar').textContent).toContain('全部链路')
    expect(screen.getByTestId('codeaudit-explore-toolbar').textContent).toContain('仅漏洞链路')
    expect(screen.getByTestId('codeaudit-explore-toolbar').textContent).toContain('纵向')
    // All-chains mode shows both intents.
    expect(screen.getAllByTestId('explore-node-intent')).toHaveLength(2)
    fireEvent.click(screen.getByTestId('codeaudit-explore-filter-findings'))
    // The dead-end intent disappears; the finding and its chain remain.
    expect(screen.getAllByTestId('explore-node-intent')).toHaveLength(1)
    expect(screen.getAllByTestId('explore-node-finding')).toHaveLength(1)
    expect(screen.queryAllByTestId('explore-node-intent').some(node => node.textContent?.includes('dead-end recon'))).toBe(false)
  })

  it('shows the no-findings note when the filter has nothing to keep', () => {
    const noFindings: CodeauditProjection = {
      ...STANDING,
      nodes: STANDING.nodes.filter(node => node.kind !== 'finding'),
      counts: { intents: 1, evidences: 2, findings: 0, assets: 1 },
    }
    render(<ExploreView codeaudit={noFindings} t={t} />)
    fireEvent.click(screen.getByTestId('codeaudit-explore-filter-findings'))
    expect(screen.getByTestId('codeaudit-explore-empty').textContent).toContain('尚无漏洞结论')
  })
})

describe('ExploreView collapse', () => {
  /** 24 nodes (over the auto-expand threshold): 20 evidences under one intent. */
  function bigProjection(): CodeauditProjection {
    const evidences = Array.from({ length: 20 }, (_, index) => ({
      id: `evidence-${index + 1}`, kind: 'evidence' as const, evidenceKind: 'sink' as const, intentId: 'intent-1',
      location: `src/A.java:${index + 1}`, detail: `sink ${index + 1}`, snippet: '', confidence: 0.5,
    }))
    const edges = [
      { id: 'edge-s', kind: 'spawns' as const, sourceId: 'engagement-1', targetId: 'intent-1' },
      ...evidences.map((evidence, index) => ({ id: `edge-y-${index + 1}`, kind: 'yields' as const, sourceId: 'intent-1', targetId: evidence.id })),
      { id: 'edge-p', kind: 'proves' as const, sourceId: 'intent-1', targetId: 'finding-1' },
      { id: 'edge-v', kind: 'supports' as const, sourceId: 'evidence-1', targetId: 'finding-1' },
    ]
    return {
      engagement: ENGAGEMENT,
      nodes: [
        { id: 'intent-1', kind: 'intent', title: 'trace everything', detail: '' },
        ...evidences,
        { id: 'finding-1', kind: 'finding', intentId: 'intent-1', title: 'sqli', severity: 'high', status: 'confirmed', cwe: '', description: '', location: 'a:1', snippet: '', poc: '', fix: '', evidenceIds: ['evidence-1'], affectedAssetId: undefined },
      ],
      assets: [],
      edges,
      counts: { intents: 1, evidences: 20, findings: 1, assets: 0 },
    }
  }

  it('starts collapsed past the threshold and expands an intent on demand', () => {
    render(<ExploreView codeaudit={bigProjection()} t={t} />)
    // Collapsed by default: no evidence cards, the intent carries the counts.
    expect(screen.queryAllByTestId('explore-node-evidence')).toHaveLength(0)
    const toggle = screen.getByTestId('codeaudit-explore-toggle-intent-1')
    expect(toggle.textContent).toContain('证据 20')
    expect(toggle.textContent).toContain('漏洞 1')
    // Expanding reveals the evidences; collapsing hides them again. Re-query
    // the toggle after each click — React Flow rebuilds node DOM elements
    // when the node types map changes.
    fireEvent.click(toggle)
    expect(screen.getAllByTestId('explore-node-evidence')).toHaveLength(20)
    fireEvent.click(screen.getByTestId('codeaudit-explore-toggle-intent-1'))
    expect(screen.queryAllByTestId('explore-node-evidence')).toHaveLength(0)
  })
})

describe('FindingsView yakit POC', () => {
  it('opens the POC drawer with the frozen HTTP raw', () => {
    render(<FindingsView codeaudit={STANDING} t={t} />)
    fireEvent.click(screen.getByTestId('codeaudit-finding-poc'))
    const drawer = screen.getByTestId('finding-poc-drawer')
    expect(drawer.textContent).toContain('可直接粘贴到 Yakit / Burp 重放')
    expect(screen.getByTestId('finding-poc-raw').textContent).toContain('POST /api/order HTTP/1.1')
    expect(screen.getByTestId('finding-poc-copy')).toBeDefined()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('finding-poc-drawer')).toBeNull()
  })

  it('shows the empty note for a finding without a POC', () => {
    const noPoc: CodeauditProjection = {
      ...STANDING,
      nodes: STANDING.nodes.map((node): CodeauditProjection['nodes'][number] =>
        node.kind === 'finding' ? { ...node, poc: '' } : node),
    }
    render(<FindingsView codeaudit={noPoc} t={t} />)
    fireEvent.click(screen.getByTestId('codeaudit-finding-poc'))
    expect(screen.getByTestId('finding-poc-empty').textContent).toContain('未记录 POC')
  })
})
