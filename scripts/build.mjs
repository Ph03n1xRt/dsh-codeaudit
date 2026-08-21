/**
 * Build the dsh-codeaudit bundle artifacts under lib/:
 *
 * 1. the Node halves (`index` / `codeaudit` / `invariant` / `preset-root` /
 *    `ui-codeaudit`), ESM bundles whose runtime imports (zod and the
 *    @deepseek-ai host/peer packages) stay external — they resolve from the
 *    installed profile;
 * 2. the browser client half (`ui-codeaudit.client`), a single CJS artifact
 *    wrapped in the __ModuleLoader__ handoff: `react` / `react-dom` /
 *    `react/jsx-runtime` stay external (the loader's module table answers
 *    them), everything else — this package's code and @xyflow/react — inlines.
 *    CSS Modules compile to hashed class maps injected through a plugin-owned
 *    `<style data-plugin>` tag; the React Flow stylesheet (global class names)
 *    rides the same injection channel as raw text.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const mkdirP = () => mkdir('lib', { recursive: true })

/** The plugin id stamped into the loader handoff and the style tags. */
const CLIENT_PLUGIN_ID = 'dsh-codeaudit/ui-codeaudit'

/** Virtual-id prefixes (must not end in `.css`: esbuild's css guard matches that). */
const CSS_MODULE_PREFIX = '\0codeaudit-css-module:'
const RAW_CSS_PREFIX = '\0codeaudit-raw-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Deterministic short hash of one string (djb2, base36). */
function hashOf(text) {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

/** Emit one plugin-owned style injector and the CSS Modules class map. */
function styleInjectionModule(css, tagId, classMap) {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(CLIENT_PLUGIN_ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/** CSS Modules for the browser bundle: hash local class names, inject the sheet. */
function cssModulesPlugin() {
  return {
    name: 'codeaudit-css-modules',
    setup(builder) {
      builder.onResolve({ filter: /\.module\.css$/ }, (args) => ({
        path: `${args.resolveDir}/${args.path}`,
        namespace: 'codeaudit-css-module',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'codeaudit-css-module' }, async (args) => {
        const fileId = args.path
        const source = await readFile(fileId, 'utf8')
        const locals = [...source.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match => match[1])
        const classMap = {}
        for (const local of new Set(locals)) {
          classMap[local] = `ca-${hashOf(fileId + local)}_${local}`
        }
        let css = source
        for (const [local, mapped] of Object.entries(classMap)) {
          css = css.replace(new RegExp(`\\.${local}(?![\\w-])`, 'g'), `.${mapped}`)
        }
        return {
          loader: 'js',
          contents: styleInjectionModule(css, `${CLIENT_PLUGIN_ID}/${hashOf(fileId)}`, classMap),
          watchFiles: [fileId],
        }
      })
    },
  }
}

/** Global stylesheets (React Flow) as runtime-injected raw text. */
function rawCssPlugin() {
  return {
    name: 'codeaudit-raw-css',
    setup(builder) {
      builder.onResolve({ filter: /\.css$/ }, (args) => {
        if (args.path.endsWith('.module.css')) return null
        let abs
        if (args.path.startsWith('.') && args.resolveDir !== '') {
          abs = require.resolve(args.path, { paths: [args.resolveDir] })
        } else {
          // A bare package stylesheet (React Flow): resolve the package root,
          // then rejoin the subpath — some exports maps hide dist files.
          try {
            abs = require.resolve(args.path)
          } catch {
            const separator = args.path.indexOf('/')
            const packageName = args.path.startsWith('@')
              ? args.path.slice(0, args.path.indexOf('/', separator + 1))
              : args.path.slice(0, separator)
            const root = dirname(require.resolve(`${packageName}/package.json`))
            abs = require('node:path').resolve(root, args.path.slice(packageName.length + 1))
          }
        }
        return { path: abs, namespace: 'codeaudit-raw-css' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'codeaudit-raw-css' }, async (args) => {
        const css = await readFile(args.path, 'utf8')
        // A UNIQUE tag per stylesheet: a shared id made every global sheet
        // after the first (xyflow) silently skip its own injection.
        return {
          loader: 'js',
          contents: styleInjectionModule(css, `${CLIENT_PLUGIN_ID}/raw/${hashOf(args.path)}`),
          watchFiles: [args.path],
        }
      })
    },
  }
}

async function main() {
  await mkdirP('lib')

  // ── Node halves ───────────────────────────────────────────────────────────
  const nodeEntries = [
    ['src/index.ts', 'lib/index.js'],
    ['src/invariant.ts', 'lib/invariant.js'],
    ['src/preset-root.ts', 'lib/preset-root.js'],
    ['src/dsh-codeaudit/src/index.ts', 'lib/codeaudit.js'],
    ['src/dsh-client-ui-codeaudit/src/index.ts', 'lib/ui-codeaudit.js'],
  ]
  for (const [entry, outfile] of nodeEntries) {
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2024',
      // Runtime imports resolve from the installed profile (zod is a declared
      // dependency; the @deepseek-ai packages are host-provided peers).
      packages: 'external',
      sourcemap: false,
      logLevel: 'info',
    })
  }

  // ── Browser client half ───────────────────────────────────────────────────
  await build({
    entryPoints: ['src/dsh-client-ui-codeaudit/src/client/index.ts'],
    outfile: 'lib/ui-codeaudit.client.js',
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    jsx: 'automatic',
    // The loader's module table answers the react rows; everything else inlines.
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [cssModulesPlugin(), rawCssPlugin()],
    banner: {
      js: [
        `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_PLUGIN_ID)}, factory: (require) => {`,
        'var module = { exports: {} }; var exports = module.exports;',
      ].join('\n'),
    },
    footer: { js: 'return module.exports; } });' },
    sourcemap: false,
    logLevel: 'info',
  })
}

await main()
