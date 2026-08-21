/**
 * The dsh-codeaudit bundle, node half: a patch-layer-only bundle. The rows in
 * `cordis.patch.yml` carry the whole surface — the Web UI row and the sqlite
 * storage backend with its route override — so this plugin body is an inert
 * loader seat, like the surface plugins the bundle composes.
 */

/** Host plugin body — no host-side behavior for this patch-only bundle. */
export function apply(): void {}
