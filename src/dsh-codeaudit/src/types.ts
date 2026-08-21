/**
 * Pure types of the codeaudit projection domain: the ONE home of the
 * `codeaudit` projection-key declaration plus its payload types, free of this
 * package's host-side value imports (zod, dsh-tools). The `./client` outlet
 * re-exports the same content for client aggregates — zero duplication.
 *
 * @module dsh-codeaudit/types
 */

import type {
  CodeauditAssetType,
  CodeauditEdgeKind,
  CodeauditEvidenceKind,
  CodeauditFindingStatus,
  CodeauditSeverity,
} from './spec.ts'

// Client consumers need the closed enum types of the payloads; re-export them
// type-only so the `./client` outlet carries the full vocabulary.
export type {
  CodeauditAssetType,
  CodeauditEdgeKind,
  CodeauditEvidenceKind,
  CodeauditFindingStatus,
  CodeauditSeverity,
} from './spec.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The engagement's current audit graph, folded from the logged
     * `codeaudit_*` tool calls (engagement plus intent/evidence/finding nodes,
     * the asset graph, and every edge); `null` before the first
     * `codeaudit_set_engagement` of the session.
     */
    codeaudit: CodeauditProjection | null
  }
}

/** The audit engagement (one per session; its node id is `engagement-1`). */
export interface CodeauditProjectionEngagement {
  readonly id: string
  readonly target: string
  readonly objective: string
  readonly scope: string
  readonly stack: string
}

/** One audit-graph node, discriminated by kind. */
export type CodeauditProjectionNode =
  | {
    readonly id: string
    readonly kind: 'intent'
    readonly title: string
    readonly detail: string
  }
  | {
    readonly id: string
    readonly kind: 'evidence'
    readonly evidenceKind: CodeauditEvidenceKind
    readonly intentId: string
    readonly location: string
    readonly detail: string
    readonly snippet: string
    readonly confidence: number
  }
  | {
    readonly id: string
    readonly kind: 'finding'
    readonly intentId: string
    readonly title: string
    readonly severity: CodeauditSeverity
    readonly status: CodeauditFindingStatus
    readonly cwe: string
    readonly description: string
    readonly location: string
    readonly snippet: string
    readonly fix: string
    /** The evidence chain backing this finding (supports edges), in submission order. */
    readonly evidenceIds: readonly string[]
    readonly affectedAssetId: string | undefined
  }

/** One asset of the engagement's asset graph. */
export interface CodeauditProjectionAsset {
  readonly id: string
  readonly type: CodeauditAssetType
  readonly value: string
  readonly meta: string
}

/** One directed graph edge (source → target). */
export interface CodeauditProjectionEdge {
  readonly id: string
  readonly kind: CodeauditEdgeKind
  readonly sourceId: string
  readonly targetId: string
}

/** The standing codeaudit state shown by the Web view tab. */
export interface CodeauditProjection {
  readonly engagement: CodeauditProjectionEngagement | null
  readonly nodes: readonly CodeauditProjectionNode[]
  readonly assets: readonly CodeauditProjectionAsset[]
  readonly edges: readonly CodeauditProjectionEdge[]
  readonly counts: {
    readonly intents: number
    readonly evidences: number
    readonly findings: number
    readonly assets: number
  }
}
