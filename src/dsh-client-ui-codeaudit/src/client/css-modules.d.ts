
/** Build-time-injected package version (scripts/build.mjs define). */
declare const __CODEAUDIT_VERSION__: string | undefined

/** highlightjs-copy ships no type declarations. */
declare module 'highlightjs-copy' {
  /** Plugin options; all optional. */
  export interface CopyButtonPluginOptions {
    readonly autohide?: boolean
    readonly hook?: (text: string, el: HTMLElement) => string
    readonly callback?: (text: string, el: HTMLElement) => void
    readonly lang?: string
  }
  export default class CopyButtonPlugin {
    constructor(options?: CopyButtonPluginOptions)
  }
}
