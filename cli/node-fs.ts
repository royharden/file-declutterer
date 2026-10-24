import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { ancestorsOf, FsError, type DirEntry, type FsErrorCode, type FsPort, type StatInfo } from '../src/core/fs-port.js'

// Native FsPort over one explicit root. Never imported by the web build. Paths stay
// root-relative with '/' separators; every resolution is checked to stay under the root, and
// every mutation first re-checks that no existing ancestor of either path is a link or
// reparse point. No overwrite, rename or copy primitive is exposed.

function mapError(error: unknown): FsError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const known: Record<string, FsErrorCode> = { EEXIST: 'EEXIST', ENOENT: 'ENOENT', ENOTEMPTY: 'ENOTEMPTY', ENOTDIR: 'ENOTDIR' }
  const message = error instanceof Error ? error.message : String(error)
  return new FsError(code && known[code] ? known[code] : 'EIO', message)
}

export interface NodeFsOptions {
  /** Absolute, already-qualified root path. */
  root: string
  rootId: string
  /** False until platform qualification passes; mutations then throw EUNSUPPORTED. */
  writesEnabled: boolean
  /** Whether file identities are qualified; unqualified identities are reported as null. */
  identityQualified: boolean
}

export class NodeFs implements FsPort {
  readonly profile = 'native' as const
  readonly rootId: string
  readonly rootDisplay: string
  private readonly root: string

  constructor(private readonly options: NodeFsOptions) {
    this.root = path.resolve(options.root)
    this.rootId = options.rootId
    this.rootDisplay = this.root
  }

  /** Resolve a root-relative path, refusing anything that would leave the root. */
  resolve(rel: string): string {
    if (rel === '') return this.root
    const parts = rel.split('/')
    if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes(':'))) {
      throw new FsError('EUNSUPPORTED', `Unsafe relative path: ${JSON.stringify(rel)}`)
    }
    const full = path.join(this.root, ...parts)
    const relative = path.relative(this.root, full)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new FsError('EUNSUPPORTED', `Path escapes the root: ${rel}`)
    return full
  }

  private async assertAncestry(rel: string): Promise<void> {
    const rootInfo = await fsp.lstat(this.root, { bigint: true })
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new FsError('EUNSUPPORTED', 'Root is no longer a plain directory.')
    // Same derivation as cli/qualify.ts: a renamed-away root replaced by a look-alike halts here.
    const currentId = `r-${createHash('sha256').update(`${rootInfo.dev}:${rootInfo.ino}`).digest('hex').slice(0, 16)}`
    if (currentId !== this.rootId) throw new FsError('EUNSUPPORTED', 'Root identity changed since qualification; refusing.')
    for (const ancestor of ancestorsOf(rel)) {
      let info
      try {
        info = await fsp.lstat(this.resolve(ancestor))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw mapError(error)
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new FsError('EUNSUPPORTED', `Ancestor ${ancestor} is a link, reparse point or file; refusing.`)
      }
    }
  }

  private requireWrites(): void {
    if (!this.options.writesEnabled) throw new FsError('EUNSUPPORTED', 'Native writes are disabled until platform qualification passes.')
  }

  async list(dir: string): Promise<DirEntry[]> {
    try {
      const entries = await fsp.readdir(this.resolve(dir), { withFileTypes: true })
      return entries.map((e) => ({
        name: e.name,
        kind: e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
      }))
    } catch (error) {
      throw mapError(error)
    }
  }

  async stat(rel: string): Promise<StatInfo | null> {
    try {
      const info = await fsp.lstat(this.resolve(rel), { bigint: true })
      const kind = info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other'
      return {
        kind,
        size: Number(info.size),
        mtimeMs: Number(info.mtimeMs),
        identity: this.options.identityQualified ? `${info.dev.toString(16)}:${info.ino.toString(16)}` : null,
        linkCount: Number(info.nlink),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw mapError(error)
    }
  }

  async sha256(rel: string): Promise<string> {
    const full = this.resolve(rel)
    const info = await fsp.lstat(full)
    if (!info.isFile()) throw new FsError('EIO', `${rel} is not a regular file`)
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      createReadStream(full)
        .on('data', (chunk) => hash.update(chunk))
        .on('error', (error) => reject(mapError(error)))
        .on('end', () => resolve(hash.digest('hex')))
    })
  }

  async mkdir(rel: string): Promise<void> {
    this.requireWrites()
    await this.assertAncestry(rel)
    try {
      await fsp.mkdir(this.resolve(rel))
    } catch (error) {
      throw mapError(error)
    }
  }

  async rmdir(rel: string): Promise<void> {
    this.requireWrites()
    await this.assertAncestry(rel)
    try {
      await fsp.rmdir(this.resolve(rel))
    } catch (error) {
      throw mapError(error)
    }
  }

  async link(src: string, dst: string): Promise<void> {
    this.requireWrites()
    await this.assertAncestry(src)
    await this.assertAncestry(dst)
    try {
      // link(2)/CreateHardLinkW fail when dst exists: exclusive by construction, never overwrites.
      await fsp.link(this.resolve(src), this.resolve(dst))
    } catch (error) {
      throw mapError(error)
    }
  }

  async unlink(rel: string): Promise<void> {
    this.requireWrites()
    await this.assertAncestry(rel)
    try {
      await fsp.unlink(this.resolve(rel))
    } catch (error) {
      throw mapError(error)
    }
  }
}
