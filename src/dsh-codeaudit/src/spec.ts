/**
 * Durable storage-domain declaration for the code-audit mode: the per-session
 * audit graph.
 *
 * One engagement (per session) starts at an **engagement**; the audit advances
 * along a chain — the engagement spawns **intents**, an intent yields
 * **evidences** (code facts: entries, sinks, dataflows, sanitizers, configs,
 * dependencies), an evidence derives a new intent, and an intent proves a
 * **finding** (a vulnerability with a concrete code location, a
 * confirmed/suspected status, and a non-empty evidence chain attached through
 * `supports` edges). **Assets** (repo / module / file / class / function /
 * endpoint / config / dependency) form a second, parent-linked graph. Every
 * relationship is an explicit **edge** row, so both graphs are fully
 * reconstructible.
 *
 * Evidences and findings may carry a **snippet**: the decisive code excerpt,
 * frozen at evidence time so the audit record stays reproducible even after
 * the code changes. The tools cap its length; the projection mirrors the cap.
 *
 * Everything is scoped to a single session: every record carries the owning
 * `sessionId`. Record schemas are zod; the domain schema validates every
 * stored record at the durable boundary (the storage-domain facility is the
 * package's guard).
 * @module dsh-codeaudit/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Kind of a recorded code evidence (the audit vocabulary). */
export const codeauditEvidenceKindSchema = z.enum(['entry', 'sink', 'dataflow', 'sanitizer', 'config', 'dependency', 'info'])
/** Severity of a vulnerability finding. */
export const codeauditSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info'])
/** Kind of a recorded code asset. */
export const codeauditAssetTypeSchema = z.enum(['repo', 'module', 'file', 'class', 'function', 'endpoint', 'config', 'dependency'])
/** Kind of an audit/asset graph edge. */
export const codeauditEdgeKindSchema = z.enum(['spawns', 'yields', 'derived_from', 'proves', 'supports', 'parent'])
/** Verification status of a finding (false-positive control). */
export const codeauditFindingStatusSchema = z.enum(['confirmed', 'suspected'])

/** Longest code excerpt kept on a record (applied by the tools and mirrored by the projection). */
export const SNIPPET_MAX_CHARS = 4000

/** Longest POC (HTTP raw) kept on a finding — a full replayable request with body. */
export const POC_MAX_CHARS = 16000

/** Truncate one snippet to the durable cap. */
export function capSnippet(value: string): string {
  return value.length > SNIPPET_MAX_CHARS ? value.slice(0, SNIPPET_MAX_CHARS) : value
}

/** Truncate one POC to the durable cap. */
export function capPoc(value: string): string {
  return value.length > POC_MAX_CHARS ? value.slice(0, POC_MAX_CHARS) : value
}

/** Non-empty id. */
const id = z.string().min(1)

/** The audit engagement: one per session, reset by the next engagement. */
export const codeauditEngagementSchema = z.object({
  id,
  sessionId: id,
  /** The audited codebase (path or repository name). */
  target: z.string(),
  /** What the audit is meant to establish (focus areas, success criteria). */
  objective: z.string(),
  /** Scope/exclusions note: directories, modules, commit range. */
  scope: z.string().default(''),
  /** Stack summary the commander recorded during mapping (e.g. Java/Spring). */
  stack: z.string().default(''),
})

/** One audit intent (what to verify / trace next). */
export const codeauditIntentSchema = z.object({
  id,
  sessionId: id,
  title: z.string().min(1),
  detail: z.string().default(''),
})

/** One code evidence yielded by an intent. */
export const codeauditEvidenceSchema = z.object({
  id,
  sessionId: id,
  intentId: id,
  kind: codeauditEvidenceKindSchema,
  /** Code position of the evidence, `path/to/file.ext:line`. */
  location: z.string().default(''),
  detail: z.string().min(1),
  /** Frozen code excerpt (capped at SNIPPET_MAX_CHARS by the tools). */
  snippet: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0.5),
})

/** One vulnerability finding proved by an intent, anchored to its evidence chain. */
export const codeauditFindingSchema = z.object({
  id,
  sessionId: id,
  intentId: id,
  title: z.string().min(1),
  severity: codeauditSeveritySchema,
  /** CWE classifier such as "CWE-89"; empty when unclassified. */
  cwe: z.string().default(''),
  description: z.string().default(''),
  /** Primary code position of the vulnerability, `path/to/file.ext:line` (required). */
  location: z.string().min(1),
  /**
   * confirmed = sanitizers/framework protections were checked and ruled out;
   * suspected = a protection or precondition could not be verified (human review).
   */
  status: codeauditFindingStatusSchema,
  /** Frozen vulnerable-code excerpt (capped at SNIPPET_MAX_CHARS by the tools). */
  snippet: z.string().default(''),
  /**
   * Replayable verification POC: the complete HTTP raw (request line, headers,
   * body) that reproduces the issue — pasteable straight into Yakit/Burp.
   * Capped at POC_MAX_CHARS; empty when the audit was static-only.
   */
  poc: z.string().default(''),
  /**
   * Human note ABOUT the POC (parameter derivation rules, placeholder
   * meanings, preconditions) — never part of the raw itself.
   */
  pocNote: z.string().default(''),
  /**
   * The Yakit hot-patch script (yak) needed to replay the poc: required when
   * the raw carries {{yak(...)}} tags or computed values (encryption,
   * signatures, timestamp-derived params). Capped at POC_MAX_CHARS.
   */
  pocScript: z.string().default(''),
  /** Fix suggestion. */
  fix: z.string().default(''),
  /** Optional asset the finding affects. */
  affectedAssetId: id.optional(),
})

/** One recorded asset; parent linkage lives on the `parent` edge row. */
export const codeauditAssetSchema = z.object({
  id,
  sessionId: id,
  type: codeauditAssetTypeSchema,
  value: z.string().min(1),
  meta: z.string().default(''),
})

/** One graph edge: source → target with a semantic kind. */
export const codeauditEdgeSchema = z.object({
  id,
  sessionId: id,
  kind: codeauditEdgeKindSchema,
  sourceId: id,
  targetId: id,
})

/**
 * The finding→evidence chain input (validated against the evidences table at
 * the write boundary; not itself a stored record — it materializes as
 * `supports` edge rows).
 */
export const codeauditSupportsInputSchema = z.array(z.string().min(1)).min(1)

/** The whole codeaudit domain: engagement/intent/evidence/finding/asset nodes plus edges. */
export const codeauditDomainSpec = defineDomain({
  name: 'codeaudit',
  version: 1,
  tables: {
    engagements: domainTable<string, z.infer<typeof codeauditEngagementSchema>>(codeauditEngagementSchema),
    intents: domainTable<string, z.infer<typeof codeauditIntentSchema>>(codeauditIntentSchema),
    evidences: domainTable<string, z.infer<typeof codeauditEvidenceSchema>>(codeauditEvidenceSchema),
    findings: domainTable<string, z.infer<typeof codeauditFindingSchema>>(codeauditFindingSchema),
    assets: domainTable<string, z.infer<typeof codeauditAssetSchema>>(codeauditAssetSchema),
    edges: domainTable<string, z.infer<typeof codeauditEdgeSchema>>(codeauditEdgeSchema),
  },
})

export type CodeauditEvidenceKind = z.infer<typeof codeauditEvidenceKindSchema>
export type CodeauditSeverity = z.infer<typeof codeauditSeveritySchema>
export type CodeauditAssetType = z.infer<typeof codeauditAssetTypeSchema>
export type CodeauditEdgeKind = z.infer<typeof codeauditEdgeKindSchema>
export type CodeauditFindingStatus = z.infer<typeof codeauditFindingStatusSchema>
export type CodeauditEngagement = z.infer<typeof codeauditEngagementSchema>
export type CodeauditIntent = z.infer<typeof codeauditIntentSchema>
export type CodeauditEvidence = z.infer<typeof codeauditEvidenceSchema>
export type CodeauditFinding = z.infer<typeof codeauditFindingSchema>
export type CodeauditAsset = z.infer<typeof codeauditAssetSchema>
export type CodeauditEdge = z.infer<typeof codeauditEdgeSchema>
