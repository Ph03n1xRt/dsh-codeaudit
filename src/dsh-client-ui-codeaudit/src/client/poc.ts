/**
 * Pure POC-shape helpers shared by the client views. Kept separate from the
 * host package so the browser bundle pulls no host-side imports.
 */

/**
 * Whether a poc references a self-implemented hot-patch function through the
 * yak(...) fuzztag — the condition for rendering the pocScript block.
 * Built-in fuzztags ({{int(1,10)}}, {{randstr(6)}}, …) replay without any
 * script, so a poc carrying only those hides the block.
 */
export function usesYakHotpatch(poc: string): boolean {
  return /\{\{\s*yak\s*\(/.test(poc)
}

/**
 * The self-implemented hot-patch function names a poc references through
 * yak(name|args) tags, in first-use order — shown as chips above the script
 * block so each {{yak(...)}} in the raw maps to a visible implementation.
 */
export function yakTagNames(poc: string): string[] {
  return [...new Set([...poc.matchAll(/\{\{\s*yak\s*\(\s*([A-Za-z_][\w]*)/g)].map(match => match[1]))]
}
