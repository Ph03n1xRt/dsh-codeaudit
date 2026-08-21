import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'

interface MemoryMedium {
  tables: Map<string, Map<string, unknown>>
  global: unknown
}

class MemoryKvUnit implements KvUnit {
  private closed = false

  constructor(
    private readonly medium: MemoryMedium,
    private readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
  ) {}

  private assertOpen(): void {
    if (this.closed) throw new StorageError('closed', `memory unit '${this.descriptor.name}' is closed`)
  }

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    return {
      tables: Object.fromEntries(this.descriptor.tables.map(table => [table, Object.fromEntries(this.medium.tables.get(table) ?? [])])),
      global: this.medium.global,
    }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    const records = this.medium.tables.get(table) ?? new Map<string, unknown>()
    this.medium.tables.set(table, records)
    records.set(key, value)
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    this.medium.tables.get(table)?.delete(key)
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    this.medium.global = value
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.onClose()
    }
  }
}

export class MemoryStorageBackend implements StorageBackend {
  readonly kv: KvFacet
  private readonly media = new Map<string, MemoryMedium>()
  private readonly versions = new Map<string, number>()
  private readonly openUnits = new Set<string>()
  private closed = false

  constructor() {
    this.kv = {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        if (this.closed) throw new StorageError('closed', 'memory backend is closed')
        if (this.openUnits.has(descriptor.name)) throw new Error(`memory unit '${descriptor.name}' is already open`)
        const version = this.versions.get(descriptor.name)
        if (version !== undefined && version !== descriptor.version) {
          throw new StorageError('version-mismatch', `memory unit '${descriptor.name}' has an incompatible version`)
        }
        this.versions.set(descriptor.name, descriptor.version)
        const medium = this.media.get(descriptor.name) ?? { tables: new Map(), global: null }
        this.media.set(descriptor.name, medium)
        this.openUnits.add(descriptor.name)
        return new MemoryKvUnit(medium, descriptor, () => this.openUnits.delete(descriptor.name))
      },
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.openUnits.clear()
  }
}
