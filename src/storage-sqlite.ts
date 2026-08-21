/**
 * The codeaudit-private SQLite storage backend.
 *
 * A vendored copy of the official dsh-storage-sqlite layout (identical
 * on-disk format: `units`/`unit_globals` meta tables plus `u_<unit>_<table>`
 * document-per-row record tables) registered under the PRIVATE backend name
 * `codeaudit-sqlite` instead of `sqlite`. The private name plus this
 * bundle's unique row id let dsh-codeaudit coexist with dsh-pentest in one
 * profile: both patches insert their own sqlite row and override the
 * `storage-domain` row, so a shared backend name or row id collides.
 * @module dsh-codeaudit/storage-sqlite
 */

import z from '@deepseek-ai/schemastery'
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { Context } from '@deepseek-ai/cordis'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** The backend name this plugin registers under (private to this bundle). */
const BACKEND_NAME = 'codeaudit-sqlite'

/** Exclusively create a missing database file with owner-only permissions. */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    await (await open(path, 'wx', 0o600)).close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Open the database and apply schema and pragmas. Missing directories and
 * database files are created owner-only (`:memory:` skips filesystem setup).
 * A zero `user_version` is stamped; every other non-current version rejects.
 */
async function openDatabase(path: string, journalMode: string): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const db = new DatabaseSync(actual)
  try {
    configureDatabase(db, actual, journalMode)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function configureDatabase(db: DatabaseSync, path: string, journalMode: string): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
  const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (onDisk !== 0 && onDisk !== 1) {
    throw new StorageError('version-mismatch', `storage database at "${path}" has schema version ${onDisk}, incompatible with this build (1)`)
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS units (
      name    TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_globals (
      unit  TEXT PRIMARY KEY REFERENCES units(name),
      value TEXT NOT NULL
    ) STRICT
  `)
  if (onDisk === 0) db.exec('PRAGMA user_version = 1')
}

/** Physical `u_<unit>_<table>` identifier (segments pre-validated). */
function recordTableName(unit: string, table: string): string {
  return `u_${unit}_${table}`
}

/** One opened SQLite KV unit: prepared statements over the record tables. */
class SqliteKvUnit implements KvUnit {
  private readonly tables = new Map<string, { upsert: ReturnType<DatabaseSync['prepare']>; remove: ReturnType<DatabaseSync['prepare']>; selectAll: ReturnType<DatabaseSync['prepare']> }>()
  private readonly globalUpsert: ReturnType<DatabaseSync['prepare']> | undefined
  private readonly globalSelect: ReturnType<DatabaseSync['prepare']> | undefined
  private closed = false

  constructor(
    private readonly db: DatabaseSync,
    private readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
  ) {
    for (const table of descriptor.tables) {
      const physical = recordTableName(descriptor.name, table)
      this.tables.set(table, {
        upsert: db.prepare(`INSERT INTO "${physical}" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
        remove: db.prepare(`DELETE FROM "${physical}" WHERE key = ?`),
        selectAll: db.prepare(`SELECT key, value FROM "${physical}"`),
      })
    }
    this.globalUpsert = descriptor.hasGlobal
      ? db.prepare('INSERT INTO unit_globals (unit, value) VALUES (?, ?) ON CONFLICT(unit) DO UPDATE SET value = excluded.value')
      : undefined
    this.globalSelect = descriptor.hasGlobal
      ? db.prepare('SELECT value FROM unit_globals WHERE unit = ?')
      : undefined
  }

  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    return this.settle(() => {
      const tables: Record<string, Record<string, unknown>> = {}
      for (const [name, statements] of this.tables) {
        const records = Object.create(null) as Record<string, unknown>
        for (const row of statements.selectAll.all() as Array<{ key: string; value: string }>) {
          records[row.key] = this.parseValue(row.value, `table '${name}' key '${row.key}'`)
        }
        tables[name] = records
      }
      let global: unknown = null
      if (this.globalSelect !== undefined) {
        const row = this.globalSelect.get(this.descriptor.name) as { value: string } | undefined
        if (row !== undefined) global = this.parseValue(row.value, 'global slot')
      }
      return { tables, global }
    })
  }

  private parseValue(text: string, slot: string): unknown {
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new StorageError('malformed-medium', `kv unit '${this.descriptor.name}' holds unparsable JSON at ${slot}`, { cause: error as Error })
    }
  }

  putRecord(table: string, key: string, value: unknown): Promise<void> {
    return this.settle(() => {
      this.statementsFor(table).upsert.run(key, JSON.stringify(value))
    })
  }

  deleteRecord(table: string, key: string): Promise<void> {
    return this.settle(() => {
      this.statementsFor(table).remove.run(key)
    })
  }

  setGlobal(value: unknown): Promise<void> {
    return this.settle(() => {
      if (this.globalUpsert === undefined) throw new Error(`kv unit '${this.descriptor.name}' declared no global slot`)
      this.globalUpsert.run(this.descriptor.name, JSON.stringify(value))
    })
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.onClose()
    }
    return Promise.resolve()
  }

  private settle<T>(operation: () => T): Promise<T> {
    try {
      this.ensureOpen()
      return Promise.resolve(operation())
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new StorageError('closed', `kv unit '${this.descriptor.name}' is closed`)
  }

  private statementsFor(table: string): { upsert: ReturnType<DatabaseSync['prepare']>; remove: ReturnType<DatabaseSync['prepare']>; selectAll: ReturnType<DatabaseSync['prepare']> } {
    const statements = this.tables.get(table)
    if (statements === undefined) throw new Error(`kv unit '${this.descriptor.name}' declared no table '${table}'`)
    return statements
  }
}

/** Cordis plugin name. */
export const name = 'codeaudit-storage-sqlite'
/** The backend registers on the storage hub. */
export const inject = ['storage']
/** Schemastery validator for the config. */
export const Config = z.object({
  path: z.string().required(),
  journalMode: z.union(['wal', 'delete', 'truncate', 'persist']).default('wal'),
})

/** The SQLite storage backend (document-per-row JSON values). */
class SqliteStorageBackend implements StorageBackend {
  readonly kv: KvFacet = { open: (descriptor: KvUnitDescriptor) => this.openUnit(descriptor) }
  private readonly ready: Promise<DatabaseSync>
  private readonly units = new Map<string, Promise<SqliteKvUnit>>()
  private closing: Promise<void> | undefined

  constructor(config: { path: string; journalMode: string }) {
    this.ready = openDatabase(config.path, config.journalMode)
    this.ready.catch(() => undefined)
  }

  private openUnit(descriptor: KvUnitDescriptor): Promise<SqliteKvUnit> {
    if (this.closing !== undefined) return Promise.reject(new StorageError('closed', `${BACKEND_NAME} storage backend is closed`))
    if (!UNIT_NAME_RE.test(descriptor.name)) return Promise.reject(new Error(`kv unit name '${descriptor.name}' violates ${UNIT_NAME_RE}`))
    for (const table of descriptor.tables) {
      if (!UNIT_NAME_RE.test(table)) return Promise.reject(new Error(`kv table name '${table}' in unit '${descriptor.name}' violates ${UNIT_NAME_RE}`))
    }
    if (this.units.has(descriptor.name)) return Promise.reject(new Error(`kv unit '${descriptor.name}' is already open (double-open is a caller bug)`))
    const pending = this.materializeUnit(descriptor)
    this.units.set(descriptor.name, pending)
    pending.catch(() => this.units.delete(descriptor.name))
    return pending
  }

  private async materializeUnit(descriptor: KvUnitDescriptor): Promise<SqliteKvUnit> {
    const db = await this.ready
    const row = db.prepare('SELECT version FROM units WHERE name = ?').get(descriptor.name) as { version: number } | undefined
    if (row === undefined) db.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run(descriptor.name, descriptor.version)
    else if (row.version !== descriptor.version) {
      throw new StorageError('version-mismatch', `kv unit '${descriptor.name}' is stamped version ${row.version} on the medium, incompatible with descriptor version ${descriptor.version}`)
    }
    for (const table of descriptor.tables) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS "${recordTableName(descriptor.name, table)}" (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT
      `)
    }
    return new SqliteKvUnit(db, descriptor, () => {
      this.units.delete(descriptor.name)
    })
  }

  close(): Promise<void> {
    this.closing ??= this.doClose()
    return this.closing
  }

  private async doClose(): Promise<void> {
    let db: DatabaseSync
    try {
      db = await this.ready
    } catch {
      return
    }
    for (const pending of [...this.units.values()]) {
      const unit = await pending.catch(() => undefined)
      await unit?.close()
    }
    db.close()
  }
}

/**
 * Register the backend as `codeaudit-sqlite` on the storage hub. The
 * disposer unregisters the name first, then closes the backend.
 * @param ctx - Plugin context (must inject `storage`).
 * @param config - Validated plugin configuration.
 */
export function apply(ctx: Context, config: { path: string; journalMode: string }): void {
  const backend = new SqliteStorageBackend(config)
  ctx.effect(() => {
    const dispose = ctx.storage.backend.register(BACKEND_NAME, backend)
    return async () => {
      dispose()
      await backend.close()
    }
  }, 'codeaudit-storage-sqlite.registerBackend')
  ctx.provide(storageBackendServiceKey(BACKEND_NAME), backend)
}
