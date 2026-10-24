// Boundary for the Windows platform helper (PLAN §6-§7). Portable Node calls cannot be claimed
// to supply volume file-system type, reparse/cloud attributes, qualified 128-bit file IDs,
// short-name aliasing, process start identity or a named root mutex. A verified helper (a
// small native binary or binding) must provide them, and must pass the disposable-root native
// cases before native writes are enabled. Until then the CLI uses UnavailableHelper and stays
// read-only.

export interface VolumeFacts {
  fileSystem: string
  serial: string
  remote: boolean
  removable: boolean
}

export interface ComponentFacts {
  path: string
  fileId: string
  reparse: boolean
  cloudPlaceholder: boolean
}

export interface RootMutex {
  /** Name in a canonical root-identity namespace. */
  readonly name: string
  /** True while the OS mutex is still held by this process. */
  held(): boolean
  release(): Promise<void>
}

export interface PlatformHelper {
  readonly available: boolean
  readonly version: string | null
  /** Why the helper is unavailable, for user-facing refusal messages. */
  readonly unavailableReason: string | null
  volume(rootPath: string): Promise<VolumeFacts>
  components(rootPath: string): Promise<ComponentFacts[]>
  fileId(fullPath: string): Promise<string>
  processStart(pid: number): Promise<string | null>
  acquireRootMutex(rootId: string): Promise<RootMutex>
  flushDirectory(fullPath: string): Promise<void>
}

export class UnavailableHelper implements PlatformHelper {
  readonly available = false
  readonly version = null
  readonly unavailableReason =
    'The Windows platform helper is not built or qualified yet. Volume type, reparse/cloud attributes, qualified file IDs, process identity and the root mutex cannot be verified, so native writes stay disabled.'

  private refuse(): never {
    throw new Error(this.unavailableReason)
  }

  async volume(): Promise<VolumeFacts> {
    return this.refuse()
  }

  async components(): Promise<ComponentFacts[]> {
    return this.refuse()
  }

  async fileId(): Promise<string> {
    return this.refuse()
  }

  async processStart(): Promise<string | null> {
    return this.refuse()
  }

  async acquireRootMutex(): Promise<RootMutex> {
    return this.refuse()
  }

  async flushDirectory(): Promise<void> {
    return this.refuse()
  }
}

export function loadPlatformHelper(): PlatformHelper {
  return new UnavailableHelper()
}
