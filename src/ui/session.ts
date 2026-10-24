import { MemoryFs, MemoryJournalStore } from '../adapters/memory-fs'
import { createSandbox } from '../adapters/sandbox-seed'
import { scanRoot } from '../core/scan'
import { DEFAULT_ROOT_CONFIG, type RootConfig } from '../core/scan-policy'
import type { ScanManifest } from '../core/types'

// One sandbox session per page load. All state is in memory; reload loses it (PLAN §2).

export class SandboxSession {
  fs: MemoryFs
  store: MemoryJournalStore
  config: RootConfig = { ...DEFAULT_ROOT_CONFIG }
  scan: ScanManifest | null = null
  busy = false
  error: string | null = null
  version = 0
  private counter = 0
  private listeners = new Set<() => void>()

  constructor() {
    this.fs = createSandbox()
    this.store = new MemoryJournalStore()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  changed(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  nextId(prefix: string): string {
    this.counter++
    return `${prefix}-${String(this.counter).padStart(4, '0')}`
  }

  reset(): void {
    this.fs = createSandbox()
    this.store = new MemoryJournalStore()
    this.config = { ...DEFAULT_ROOT_CONFIG }
    this.scan = null
    this.error = null
    this.changed()
  }

  async runScan(): Promise<ScanManifest | null> {
    this.busy = true
    this.error = null
    this.changed()
    try {
      this.scan = await scanRoot(this.fs, { scanId: this.nextId('scan'), mode: 'organize', config: this.config })
      return this.scan
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      return null
    } finally {
      this.busy = false
      this.changed()
    }
  }
}
