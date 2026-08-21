/**
 * Invariant companion seat for the codeaudit UI surface package. The surface
 * plugin contributes no durable state — its whole body is the browser-half
 * view registration — so there is no package-owned discipline to install.
 */

/** Cordis companion plugin name. */
export const name = 'dsh-client-ui-codeaudit-invariant'

/** No runtime invariants: an inert seat keeping the companion contract. */
export function apply(): void {}
