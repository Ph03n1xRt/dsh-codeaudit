/**
 * Model-facing `codeaudit_*` tools: record the audit graph
 * (engagement → intent → evidence → intent → finding, with the finding's
 * evidence chain on `supports` edges), record code assets, read the current
 * state, and dump the graph or the final report for one session.
 *
 * Record ownership discipline: the decision agent writes and reads its own
 * graph with `codeaudit_set_engagement`/`codeaudit_add_*` and the read tools.
 * Execution subagents use only `codeaudit_submit`, which resolves the parent
 * session from session ancestry.
 * @module dsh-codeaudit/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import { capSnippet } from './spec.ts'
import type {
  AssetInput,
  CodeauditStateView,
  CodeauditStore,
  EvidenceInput,
  FindingInput,
} from './store.ts'

/** Resolve the calling session id or fail a non-agent caller (like todo_write). */
function sessionIdOf(exec: { agent?: { session: { id: string } } }): string {
  if (!exec.agent) {
    throw new Error('codeaudit_* tools require an owning agent session')
  }
  return exec.agent.session.id
}

/** Resolve the only graph a delegated child is allowed to submit into. */
function parentSessionIdOf(exec: { agent?: { session: { header?: { parentSession?: string } } } }): string {
  const parentSessionId = exec.agent?.session.header?.parentSession
  if (parentSessionId === undefined || parentSessionId === '') {
    throw new Error('codeaudit_submit is only available to a delegated subagent with a parent session')
  }
  return parentSessionId
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`codeaudit_submit requires ${name}`)
  return value
}

/** Reject prompt variables before they are mistaken for a parent graph id. */
function concreteIntentId(value: string): string {
  const normalized = value.trim()
  if (/^(?:[<{[]\s*)?(?:delegation[-_])?intent[-_]?id(?:\s*[>}\]])?$/i.test(normalized)) {
    throw new Error(`codeaudit_submit requires the concrete parent intent ID returned by codeaudit_add_intent; received placeholder ${JSON.stringify(value)}`)
  }
  return normalized
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Normalize one snippet: optional string, capped to the durable limit. */
function snippetValue(value: unknown): string {
  return capSnippet(optionalString(value))
}

function submissionList(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) {
    throw new Error(`codeaudit_submit requires ${name} to be an array of objects`)
  }
  return value as Record<string, unknown>[]
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string' && item !== '')) {
    throw new Error(`codeaudit_submit ${name} must be a non-empty array of strings`)
  }
  return value
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number], name: string): T[number] {
  if (value === undefined) return fallback
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T[number]
  throw new Error(`codeaudit_submit ${name} must be one of: ${allowed.join(', ')}`)
}

function confidenceValue(value: unknown): number {
  if (value === undefined) return 0.5
  const text = typeof value === 'string' ? value.trim() : undefined
  const isPercent = text?.endsWith('%') === true
  const parsed = typeof value === 'number'
    ? value
    : text === undefined || text === '' ? Number.NaN : Number(isPercent ? text.slice(0, -1) : text)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('codeaudit_submit confidence must be 0..1 or a percentage from 0 to 100')
  }
  if (isPercent || parsed > 1) {
    if (parsed > 100) throw new Error('codeaudit_submit confidence must be 0..1 or a percentage from 0 to 100')
    return parsed / 100
  }
  return parsed
}

/** Completed generic card for the read-only projections: a domain title over the raw content. */
function titledCard(title: string, result: ToolResult): ToolResultView | undefined {
  if (result.isError) return undefined
  return { card: 'generic', title, content: result.content }
}

/** The closed enum values exposed by the tools. */
const EVIDENCE_KINDS = ['entry', 'sink', 'dataflow', 'sanitizer', 'config', 'dependency', 'info'] as const
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
const ASSET_TYPES = ['repo', 'module', 'file', 'class', 'function', 'endpoint', 'config', 'dependency'] as const
const FINDING_STATUSES = ['confirmed', 'suspected'] as const

/** Report display order: severities worst-first. */
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const

let submissionProjectionEvent = 0

/**
 * Drive the live parent projection from a delegated write. The durable graph
 * lives in storage, while the Web client consumes the session projection;
 * regular tool calls are the shared, known event vocabulary that updates both
 * the projection and history replay without introducing a custom session event.
 */
function appendSubmissionProjection(
  parent: unknown,
  intentId: string,
  evidences: EvidenceInput[],
  assets: AssetInput[],
  findings: FindingInput[],
): void {
  const append = (parent as { append: (type: 'tool/call', data: Record<string, unknown>) => unknown }).append.bind(parent)
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [
    ...evidences.map(evidence => ({ name: 'codeaudit_add_evidence', args: { ...evidence, intentId } })),
    ...assets.map(asset => ({ name: 'codeaudit_add_asset', args: { ...asset } })),
    ...findings.map(finding => ({ name: 'codeaudit_add_finding', args: { ...finding, intentId } })),
  ]
  for (const call of calls) {
    submissionProjectionEvent += 1
    append('tool/call', {
      turn: 0,
      step: submissionProjectionEvent,
      callId: `codeaudit-submit-${submissionProjectionEvent}`,
      name: call.name,
      arguments: JSON.stringify(call.args),
    })
  }
}

/** Build the audit-graph dump for one session (pure projection). */
function buildGraph(state: CodeauditStateView): {
  engagement: CodeauditStateView['engagement'] | null
  intents: CodeauditStateView['intents']
  evidences: CodeauditStateView['evidences']
  findings: CodeauditStateView['findings']
  assets: CodeauditStateView['assets']
  edges: CodeauditStateView['edges']
} {
  return {
    engagement: state.engagement ?? null,
    intents: state.intents,
    evidences: state.evidences,
    findings: state.findings,
    assets: state.assets,
    edges: state.edges,
  }
}

/** Count findings per severity, worst first (pure projection). */
function severityCounts(findings: CodeauditStateView['findings']): Record<string, number> {
  const counts = Object.fromEntries(SEVERITY_ORDER.map(severity => [severity, 0]))
  for (const finding of findings) counts[finding.severity] += 1
  return counts
}

/** Build the final report for one session (pure projection). */
function buildReport(state: CodeauditStateView): string {
  if (state.engagement === undefined) {
    return ['# 代码审计报告', '', '（未初始化：尚未调用 codeaudit_set_engagement。）'].join('\n')
  }
  const engagement = state.engagement
  const anchorOf = (targetId: string): string => {
    const edge = state.edges.find(e => e.targetId === targetId)
    /* v8 ignore next 1 -- unreachable: the store writes the connecting edge with every node. */
    return edge === undefined ? '?' : `${edge.kind} ${edge.sourceId}`
  }
  const evidenceOf = (evidenceId: string): string => {
    const evidence = state.evidences.find(e => e.id === evidenceId)
    if (evidence === undefined) return evidenceId
    return `${evidence.id} [${evidence.kind}]${evidence.location === '' ? '' : ` ${evidence.location}`} ${evidence.detail}`
  }
  // The evidence chain materializes as supports edge rows (written in the
  // caller's evidenceIds order; edges sort by numeric id, so the order holds).
  const evidenceChainOf = (findingId: string): string[] =>
    state.edges.filter(e => e.kind === 'supports' && e.targetId === findingId).map(e => e.sourceId)
  const counts = severityCounts(state.findings)
  const confirmed = state.findings.filter(f => f.status === 'confirmed').length
  const suspected = state.findings.length - confirmed
  const orderedFindings = [...state.findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
  const chainLines = [
    `- 任务 (engagement ${engagement.id})「${engagement.target}」— 审计目标: ${engagement.objective}`,
    ...state.intents.map(intent => `- 意图 (intent ${intent.id})「${intent.title}」(${anchorOf(intent.id)})${intent.detail === '' ? '' : ` — ${intent.detail}`}`),
    ...state.evidences.map(evidence => `- 证据 (evidence ${evidence.id}) [${evidence.kind}]${evidence.location === '' ? '' : ` ${evidence.location}: `}${evidence.detail} (${anchorOf(evidence.id)})`),
    ...orderedFindings.map(finding => `- 漏洞 (finding ${finding.id}) [${finding.severity}|${finding.status}] ${finding.title} (${anchorOf(finding.id)})`),
  ]
  const findingSections = orderedFindings.map((finding) => {
    const asset = finding.affectedAssetId === undefined ? undefined : state.assets.find(a => a.id === finding.affectedAssetId)
    return [
      `### ${finding.id} [${finding.severity}|${finding.status}] ${finding.title}`,
      `- 描述: ${finding.description === '' ? '（无）' : finding.description}`,
      `- CWE: ${finding.cwe === '' ? '（未分类）' : finding.cwe}`,
      `- 位置: ${finding.location}`,
      `- 影响资产: ${asset === undefined ? '（未关联）' : `[${asset.type}] ${asset.value}`}`,
      `- 修复建议: ${finding.fix === '' ? '（无）' : finding.fix}`,
      '- 证据链:',
      ...evidenceChainOf(finding.id).map((evidenceId, index) => `  ${index + 1}. ${evidenceOf(evidenceId)}`),
    ].join('\n')
  })
  const assetLines = state.assets.map((asset) => {
    const parent = state.edges.find(e => e.kind === 'parent' && e.targetId === asset.id)
    const parentAsset = parent === undefined ? undefined : state.assets.find(a => a.id === parent.sourceId)
    return `- [${asset.type}] ${asset.value}${asset.meta === '' ? '' : `（${asset.meta}）`}${parentAsset === undefined ? '' : ` ← ${parentAsset.value}`}`
  })
  return [
    '# 代码审计报告',
    '',
    '## 执行摘要',
    `- 发现合计: ${state.findings.length}（confirmed ${confirmed} / suspected ${suspected}）`,
    `- 严重分布: ${SEVERITY_ORDER.map(severity => `${severity} ${counts[severity]}`).join(' / ')}`,
    `- 审计意图 ${state.intents.length} · 证据 ${state.evidences.length} · 资产 ${state.assets.length}`,
    '',
    '## 任务信息',
    `- 目标 (target): ${engagement.target}`,
    `- 审计目标 (objective): ${engagement.objective}`,
    `- 范围 (scope): ${engagement.scope === '' ? '（未声明）' : engagement.scope}`,
    `- 技术栈 (stack): ${engagement.stack === '' ? '（未记录）' : engagement.stack}`,
    '',
    '## 探索链路',
    ...(chainLines.length === 1 ? ['（仅任务，尚未展开）'] : chainLines),
    '',
    '## 漏洞发现',
    ...(findingSections.length === 0 ? ['（无）'] : findingSections),
    '',
    '## 代码资产',
    ...(assetLines.length === 0 ? ['（无）'] : assetLines),
    '',
  ].join('\n')
}

/** Register all `codeaudit_*` tools on the caller's tool registry. */
export function registerCodeauditTools(ctx: Context, store: CodeauditStore): void {
  ctx.tools.register(defineTool({
    name: 'codeaudit_submit',
    description: 'Immediately submit each newly confirmed delegated result directly into the specified parent intent. Available only to subagents: it records code evidences (with file:line locations and code snippets), assets, and evidence-backed findings in the parent graph, refreshes the parent projection, then returns the submission counts PLUS the exact ids assigned to this batch (evidenceIds / assetIds / findingIds) — reference those returned ids in later batches or findings; NEVER invent or guess ids. Use it as real-time checkpoints; never resubmit an item. parentId and affectedAssetId may reference only an existing parent-session asset supplied in the delegation or returned by an earlier codeaudit_submit; a finding evidenceIds may reference ids returned by this same call (list its evidences first) or an earlier one. Keep the target codebase read-only: reading, searching, and static analysis only; run any dynamic verification in an isolated scratch directory.',
    parameters: {
      intentId: { type: 'string', required: true, description: 'The parent intent id supplied in the delegation prompt.' },
      evidences: { type: 'array', required: true, description: 'Code evidences to attach to the parent intent.', items: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', enum: EVIDENCE_KINDS, description: 'Evidence kind: entry / sink / dataflow / sanitizer / config / dependency / info (default info).' },
        location: { type: 'string', description: 'Code position of the evidence, "path/to/file.ext:line".' },
        detail: { type: 'string', required: true, description: 'What the evidence establishes (semantic description, not pasted source).' },
        snippet: { type: 'string', description: 'The decisive code excerpt (frozen with the evidence, capped).' },
        confidence: { oneOf: [
          { type: 'number', description: 'Confidence 0..1, or 0..100 as a percentage.' },
          { type: 'string', description: 'Percentage such as "90%".' },
        ] },
      } } },
      assets: { type: 'array', required: true, description: 'New code assets discovered during execution. parentId may reference only an existing parent-session asset supplied in the delegation.', items: { type: 'object', additionalProperties: true, properties: {
        type: { type: 'string', required: true, enum: ASSET_TYPES, description: 'Asset type: repo / module / file / class / function / endpoint / config / dependency.' },
        value: { type: 'string', required: true, description: 'Asset value (path, qualified name, endpoint, package@version).' },
        parentId: { type: 'string', description: 'Existing parent-session asset id, when known.' },
        meta: { type: 'string', description: 'Optional asset metadata.' },
      } } },
      findings: { type: 'array', required: true, description: 'New evidence-backed findings. affectedAssetId may reference only an existing parent-session asset supplied in the delegation; evidenceIds may reference evidences from this batch or earlier ones.', items: { type: 'object', additionalProperties: false, properties: {
        title: { type: 'string', required: true, description: 'Short vulnerability title.' },
        severity: { type: 'string', enum: SEVERITIES, description: 'Severity (default info).' },
        status: { type: 'string', enum: FINDING_STATUSES, description: 'confirmed = sanitizers/framework protections checked and ruled out; suspected = could not verify (default suspected).' },
        location: { type: 'string', required: true, description: 'Primary code position "path/to/file.ext:line".' },
        cwe: { type: 'string', description: 'CWE classifier such as "CWE-89".' },
        description: { type: 'string', description: 'Impact or root-cause description; for suspected findings, state what remains unverified.' },
        fix: { type: 'string', description: 'Fix suggestion.' },
        snippet: { type: 'string', description: 'The vulnerable code excerpt (capped).' },
        evidenceIds: { type: 'array', required: true, description: 'The evidence chain backing this finding (min one; ids from this batch or earlier submissions).', items: { type: 'string' } },
        affectedAssetId: { type: 'string', description: 'Existing affected parent-session asset id, when known.' },
      } } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        evidences: { type: 'number', required: true },
        assets: { type: 'number', required: true },
        findings: { type: 'number', required: true },
        /** The ids assigned to this batch — reference THESE in later batches; never invent ids. */
        evidenceIds: { type: 'array', required: true, items: { type: 'string' } },
        assetIds: { type: 'array', required: true, items: { type: 'string' } },
        findingIds: { type: 'array', required: true, items: { type: 'string' } },
      } },
      render: (_a, value) => [{ type: 'text', text: `Submitted ${value.evidences} evidences (${value.evidenceIds.join(', ') || 'none'}), ${value.assets} assets (${value.assetIds.join(', ') || 'none'}), and ${value.findings} findings (${value.findingIds.join(', ') || 'none'}) to the parent session.` }],
    },
    execute: async (args, exec) => {
      const parentSessionId = parentSessionIdOf(exec)
      const input = args as Record<string, unknown>
      const intentId = concreteIntentId(requiredString(input.intentId, 'intentId'))
      const evidences = submissionList(input.evidences, 'evidences')
      const assets = submissionList(input.assets, 'assets')
      const findings = submissionList(input.findings, 'findings')
      // Do not persist a partial submission which cannot be surfaced through
      // the parent session projection.
      const parent = ctx.sessions.get(parentSessionId as never)
      if (parent === undefined) throw new Error(`codeaudit_submit parent session ${parentSessionId} is not live`)

      const evidenceWrites: EvidenceInput[] = evidences.map(evidence => ({
          intentId,
          kind: enumValue(evidence.kind, EVIDENCE_KINDS, 'info', 'evidence.kind'),
          location: optionalString(evidence.location),
          detail: requiredString(evidence.detail, 'evidence.detail'),
          snippet: snippetValue(evidence.snippet),
          confidence: confidenceValue(evidence.confidence),
      }))
      const assetWrites: AssetInput[] = assets.map(asset => ({
          type: enumValue(asset.type, ASSET_TYPES, 'file', 'asset.type'),
          value: requiredString(asset.value, 'asset.value'),
          meta: optionalString(asset.meta),
          ...(typeof asset.parentId === 'string' ? { parentId: asset.parentId } : {}),
      }))
      const findingWrites: FindingInput[] = findings.map(finding => ({
          intentId,
          title: requiredString(finding.title, 'finding.title'),
          severity: enumValue(finding.severity, SEVERITIES, 'info', 'finding.severity'),
          status: enumValue(finding.status, FINDING_STATUSES, 'suspected', 'finding.status'),
          cwe: optionalString(finding.cwe),
          description: optionalString(finding.description),
          location: requiredString(finding.location, 'finding.location'),
          snippet: snippetValue(finding.snippet),
          fix: optionalString(finding.fix),
          evidenceIds: stringList(finding.evidenceIds, 'finding.evidenceIds'),
          ...(typeof finding.affectedAssetId === 'string' ? { affectedAssetId: finding.affectedAssetId } : {}),
      }))
      const assigned = await store.addSubmission(parentSessionId, intentId, evidenceWrites, assetWrites, findingWrites)
      appendSubmissionProjection(parent, intentId, evidenceWrites, assetWrites, findingWrites)
      return {
        evidences: evidences.length,
        assets: assets.length,
        findings: findings.length,
        evidenceIds: [...assigned.evidenceIds],
        assetIds: [...assigned.assetIds],
        findingIds: [...assigned.findingIds],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'codeaudit_set_engagement',
    description: 'Start a code-audit engagement: set the target codebase and audit objective, RESETTING the whole audit graph of this session (a new engagement starts a fresh chain). Call this once before recording intents, evidences, findings, or assets. The scope note (directories/modules in or out, commit range) declares what the audit covers; intents beyond it should be rejected.',
    parameters: {
      target: { type: 'string', required: true, description: 'The audited codebase (repo path or repository name).' },
      objective: { type: 'string', required: true, description: 'The audit objective (focus areas, success criteria).' },
      scope: { type: 'string', description: 'Optional scope/exclusions note (directories, modules, commit range).' },
      stack: { type: 'string', description: 'Optional stack summary (e.g. "Java/Spring", "Python/Django"), recorded during mapping.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        target: { type: 'string', required: true },
        objective: { type: 'string', required: true },
      } },
      render: (_a, v) => [{ type: 'text', text: `Recorded engagement ${v.id} → ${v.target}.` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      const engagement = await store.initEngagement(sessionId, {
        target: args.target,
        objective: args.objective,
        scope: args.scope ?? '',
        stack: args.stack ?? '',
      })
      return { id: engagement.id, target: engagement.target, objective: engagement.objective }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'codeaudit_add_intent',
    description: 'Record one audit intent (what to verify / trace next) as a node in the audit chain. Anchor it with EXACTLY ONE of: engagementId (spawns: an intent working toward the engagement) or derivedFromEvidenceId (derived_from: a new intent derived from a previously recorded evidence). The edge kind is recorded automatically.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short intent title (e.g. "trace /api/order query params to SQL execution").' },
      detail: { type: 'string', description: 'Optional detail (scope, hypothesis, expected evidence).' },
      engagementId: { type: 'string', description: 'Anchor engagement id (spawns edge). Exactly one of engagementId / derivedFromEvidenceId is required.' },
      derivedFromEvidenceId: { type: 'string', description: 'Anchor evidence id (derived_from edge). Exactly one of engagementId / derivedFromEvidenceId is required.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        title: { type: 'string', required: true },
        edgeId: { type: 'string', required: true },
        edgeKind: { type: 'string', required: true },
        sourceId: { type: 'string', required: true },
      } },
      render: (_a, v) => [{ type: 'text', text: `Recorded intent ${v.id}「${v.title}」 (${v.edgeKind} ${v.sourceId} → ${v.id}, edge ${v.edgeId}).` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      const write = await store.addIntent(sessionId, {
        title: args.title,
        detail: args.detail ?? '',
        ...(args.engagementId !== undefined ? { engagementId: args.engagementId } : {}),
        ...(args.derivedFromEvidenceId !== undefined ? { derivedFromEvidenceId: args.derivedFromEvidenceId } : {}),
      })
      /* v8 ignore next 1 -- unreachable: the store always writes the connecting edge for intent writes. */
      return { id: write.nodeId, title: args.title, edgeId: write.edge?.id ?? '', edgeKind: write.edge?.kind ?? '', sourceId: write.edge?.sourceId ?? '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'codeaudit_add_evidence',
    description: 'Record one code evidence yielded by an intent. This is a decision-agent tool; execution subagents submit evidences through codeaudit_submit.',
    parameters: {
      intentId: { type: 'string', required: true, description: 'The intent id that yielded this evidence (yields edge).' },
      detail: { type: 'string', required: true, description: 'What the evidence establishes (e.g. "query built by string concatenation").' },
      kind: { type: 'string', enum: EVIDENCE_KINDS, description: 'Evidence kind: entry / sink / dataflow / sanitizer / config / dependency / info (default info).' },
      location: { type: 'string', description: 'Code position "path/to/file.ext:line".' },
      snippet: { type: 'string', description: 'The decisive code excerpt (frozen with the evidence, capped).' },
      confidence: { oneOf: [
        { type: 'number', description: 'Confidence 0..1, or 0..100 as a percentage.' },
        { type: 'string', description: 'Percentage such as "90%".' },
      ], description: 'Confidence (default 0.5).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        kind: { type: 'string', required: true },
        detail: { type: 'string', required: true },
        edgeId: { type: 'string', required: true },
      } },
      render: (_a, v) => [{ type: 'text', text: `Recorded evidence ${v.id} [${v.kind}] ${v.detail} (edge ${v.edgeId}).` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      const write = await store.addEvidence(sessionId, {
        intentId: args.intentId,
        kind: args.kind ?? 'info',
        location: args.location ?? '',
        detail: args.detail,
        snippet: snippetValue(args.snippet),
        confidence: confidenceValue(args.confidence),
      })
      /* v8 ignore next 1 -- unreachable: the store always writes the connecting edge for evidence writes. */
      return { id: write.nodeId, kind: args.kind ?? 'info', detail: args.detail, edgeId: write.edge?.id ?? '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'codeaudit_add_finding',
    description: 'Record one vulnerability finding proved by an intent (proves edge, plus one supports edge per referenced evidence). The finding MUST carry a concrete code location (location, "path/to/file.ext:line") and a non-empty evidence chain (evidenceIds, min 1 — enforced at the durable boundary). status=confirmed only when sanitizers/framework protections were checked and ruled out; otherwise use suspected and state what remains unverified. Optionally link the affected asset and record a fix suggestion.',
    parameters: {
      intentId: { type: 'string', required: true, description: 'The intent id that proved this finding (proves edge).' },
      title: { type: 'string', required: true, description: 'Short finding title (e.g. "SQL injection in OrderDao.findByUser").' },
      severity: { type: 'string', required: true, enum: SEVERITIES, description: 'Severity: critical / high / medium / low / info.' },
      status: { type: 'string', required: true, enum: FINDING_STATUSES, description: 'confirmed / suspected.' },
      location: { type: 'string', required: true, description: 'Primary code position "path/to/file.ext:line" (required).' },
      evidenceIds: { type: 'array', required: true, description: 'The evidence chain backing this finding (min one; supports edges are created automatically).', items: { type: 'string' } },
      cwe: { type: 'string', description: 'Optional CWE classifier such as "CWE-89".' },
      description: { type: 'string', description: 'Impact / root-cause description; for suspected findings, state what remains unverified.' },
      fix: { type: 'string', description: 'Optional fix suggestion.' },
      snippet: { type: 'string', description: 'Optional vulnerable code excerpt (capped).' },
      affectedAssetId: { type: 'string', description: 'Optional asset id this finding affects.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        title: { type: 'string', required: true },
        severity: { type: 'string', required: true },
        edgeIds: { type: 'array', required: true, items: { type: 'string' } },
      } },
      render: (_a, v) => [{ type: 'text', text: `Recorded finding ${v.id} [${v.severity}] ${v.title} (edges ${v.edgeIds.join(', ')}).` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      const write = await store.addFinding(sessionId, {
        intentId: args.intentId,
        title: args.title,
        severity: args.severity,
        status: args.status,
        cwe: args.cwe ?? '',
        description: args.description ?? '',
        location: args.location,
        snippet: snippetValue(args.snippet),
        fix: args.fix ?? '',
        evidenceIds: args.evidenceIds,
        ...(args.affectedAssetId !== undefined ? { affectedAssetId: args.affectedAssetId } : {}),
      })
      return { id: write.nodeId, title: args.title, severity: args.severity, edgeIds: [...write.edgeIds] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'codeaudit_add_asset',
    description: 'Record one code asset of the engagement: repo, module, file, class, function, endpoint, config, or dependency. Optionally link it to a parent asset (parentId, e.g. a file under its module, a function under its file) so the asset graph reflects real ownership. parentId may be omitted or an empty string for a root asset. Record parent assets BEFORE their children and reuse the returned ids.',
    parameters: {
      type: { type: 'string', required: true, enum: ASSET_TYPES, description: 'Asset type: repo / module / file / class / function / endpoint / config / dependency.' },
      value: { type: 'string', required: true, description: 'The asset value (e.g. "src/main/java/.../OrderDao.java", "POST /api/order", "jackson-databind@2.13.0").' },
      parentId: { type: 'string', description: 'Optional parent asset id (parent edge, e.g. the module owning this file).' },
      meta: { type: 'string', description: 'Optional free-form metadata (framework, version, note).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        type: { type: 'string', required: true },
        value: { type: 'string', required: true },
        edgeId: { type: 'string' },
      } },
      render: (_a, v) => [{ type: 'text', text: `Recorded asset ${v.id} [${v.type}] ${v.value}${v.edgeId === undefined ? '' : ` (parent edge ${v.edgeId})`}.` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      const write = await store.addAsset(sessionId, {
        type: args.type,
        value: args.value,
        ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
        meta: args.meta ?? '',
      })
      return {
        id: write.nodeId,
        type: args.type,
        value: args.value,
        ...(write.edge !== undefined ? { edgeId: write.edge.id } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'codeaudit_state',
    description: 'Read the current code-audit state for this session: engagement, node counts (with severity and confirmed/suspected breakdown), and short node/asset listings. Call this to decide the next audit step and to check for equivalent intents before creating a new one.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          initialized: { type: 'boolean', required: true },
          engagement: { type: 'object', additionalProperties: true, properties: {} },
          counts: { type: 'object', additionalProperties: true, properties: {} },
          intents: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
          evidences: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
          findings: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
          assets: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
          edges: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
        },
      },
      render: (_a, v) => {
        const view = v as unknown as CodeauditStateView
        if (!view.initialized || view.engagement === undefined) {
          return [{ type: 'text', text: 'Not initialized. Call codeaudit_set_engagement with target and objective.' }]
        }
        const engagement = view.engagement
        const join = (rows: readonly string[]): string => rows.join('; ') || 'none'
        const counts = severityCounts(view.findings)
        const confirmed = view.findings.filter(f => f.status === 'confirmed').length
        const severityText = SEVERITY_ORDER.map(severity => `${severity} ${counts[severity]}`).join(', ')
        const body = `Target: ${engagement.target} | Objective: ${engagement.objective} | ${view.counts.intents} intents, ${view.counts.evidences} evidences, ${view.counts.findings} findings (${severityText}; confirmed ${confirmed}, suspected ${view.counts.findings - confirmed}), ${view.counts.assets} assets. Intents: ${join(view.intents.map(i => `${i.id}「${i.title}」`))}. Evidences: ${join(view.evidences.map(e => `${e.id} [${e.kind}]${e.location === '' ? '' : ` ${e.location}: `}${e.detail}`))}. Findings: ${join(view.findings.map(f => `${f.id} [${f.severity}|${f.status}] ${f.title}`))}. Assets: ${join(view.assets.map(a => `${a.id} [${a.type}] ${a.value}`))}.`
        return [{ type: 'text', text: body }]
      },
    },
    presentResult: (_args, result) => titledCard('代码审计状态', result),
    execute: async (_args, exec) => {
      const sessionId = sessionIdOf(exec)
      const view = await store.view(sessionId)
      // The view's record shapes are richer than the schema's permissive JSON
      // item types; the runtime value round-trips fine and the render below
      // re-narrows it.
      return view as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'codeaudit_graph',
    description: 'Dump the full audit graph of this session as JSON: engagement, intents, evidences, findings, assets, and every edge (spawns / yields / derived_from / proves / supports / parent). Use this to review the chain before reporting.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { graph: { type: 'object', additionalProperties: true, properties: {} } } },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v.graph) }],
    },
    presentResult: (_args, result) => titledCard('代码审计图', result),
    execute: async (_args, exec) => {
      const sessionId = sessionIdOf(exec)
      const state = await store.view(sessionId)
      // The graph is richer than the schema's permissive object item type; the
      // runtime value round-trips fine and the render stringifies it.
      return { graph: buildGraph(state) } as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'codeaudit_report',
    description: 'Generate the final Markdown report for this session: executive summary (severity/status counts), engagement info, the audit chain (engagement → intents → evidences → derived intents → findings), every vulnerability with its location, CWE, evidence chain, and fix suggestion, and the code-asset inventory. Call this when the audit is done.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { markdown: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text', text: v.markdown }],
    },
    presentResult: (_args, result) => titledCard('代码审计报告', result),
    execute: async (_args, exec) => {
      const sessionId = sessionIdOf(exec)
      const state = await store.view(sessionId)
      return { markdown: buildReport(state) }
    },
  }))
}
