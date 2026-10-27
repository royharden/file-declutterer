import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { PlatformHelper } from './platform/helper.js'
import { qualifiedRootId } from './qualify.js'
import { isWithin } from './within.js'
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
  /** Only supplied after the real platform helper has been explicitly qualified. */
  helper?: PlatformHelper
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
    if (!isWithin(full, this.root)) throw new FsError('EUNSUPPORTED', `Path escapes the root: ${rel}`)
    return full
  }

  private async assertAncestry(rel: string): Promise<void> {
    const rootInfo = await fsp.lstat(this.root, { bigint: true })
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new FsError('EUNSUPPORTED', 'Root is no longer a plain directory.')
    const helper = this.options.helper
    if (helper && (!helper.available || !this.options.identityQualified)) throw new FsError('EUNSUPPORTED', 'Qualified helper unavailable.')
    // Same derivation as qualification; helpers never mix 128-bit IDs with portable stat IDs.
    const currentId = helper ? qualifiedRootId(await helper.fileId(this.root)) : `r-${createHash('sha256').update(`${rootInfo.dev}:${rootInfo.ino}`).digest('hex').slice(0, 16)}`
    if (currentId !== this.rootId) throw new FsError('EUNSUPPORTED', 'Root identity changed since qualification; refusing.')
    if (helper) {
      // Inspect the nearest existing leaf, including all its existing ancestry. Missing
      // destination components do not skip the existing parent safety check.
      let existing = this.resolve(rel)
      for (;;) {
        try { await fsp.lstat(existing); break } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existing === this.root) throw error
          existing = path.dirname(existing)
        }
      }
      const rootFileId = await helper.fileId(this.root)
      const facts = await helper.components(existing)
      if (!facts.length) throw new FsError('EUNSUPPORTED', 'No native ancestry facts.')
      for (const c of facts) {
        if (c.reparse || c.cloudPlaceholder) throw new FsError('EUNSUPPORTED', 'Native path has reparse/cloud ancestry.')
        if (isWithin(c.path, this.root) && (c.hidden || c.system)) throw new FsError('EUNSUPPORTED', 'Hidden/system native path is protected.')
        if (isWithin(c.path, this.root) && c.fileId.split(':')[0] !== rootFileId.split(':')[0]) throw new FsError('EUNSUPPORTED', 'Native path crosses a volume.')
      }
    }
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
      if (this.options.helper) await this.assertAncestry(dir)
      const entries = await fsp.readdir(this.resolve(dir), { withFileTypes: true })
      const result: DirEntry[] = []
      for (const e of entries) {
        const facts = this.options.helper && !e.isSymbolicLink() ? (await this.options.helper.components(path.join(this.resolve(dir), e.name))).at(-1) : undefined
        result.push({ name: e.name, kind: e.isSymbolicLink() || facts?.reparse || facts?.cloudPlaceholder ? 'link' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', hidden: facts?.hidden ?? false, system: facts?.system ?? false })
      }
      return result
    } catch (error) {
      throw mapError(error)
    }
  }

  async stat(rel: string): Promise<StatInfo | null> {
    try {
      if (this.options.helper) await this.assertAncestry(rel)
      const info = await fsp.lstat(this.resolve(rel), { bigint: true })
      const kind = info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other'
      return {
        kind,
        size: Number(info.size),
        mtimeMs: Number(info.mtimeMs),
        identity: this.options.identityQualified ? (this.options.helper ? await this.options.helper.fileId(this.resolve(rel)) : `${info.dev.toString(16)}:${info.ino.toString(16)}`) : null,
        linkCount: Number(info.nlink),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw mapError(error)
    }
  }

  async sha256(rel: string): Promise<string> {
    if (this.options.helper) await this.assertAncestry(rel)
    const full = this.resolve(rel)
    const info = await fsp.lstat(full)
    if (!info.isFile() || info.isSymbolicLink()) throw new FsError('EIO', `${rel} is not a regular file`)
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
      await this.options.helper?.flushDirectory(path.dirname(this.resolve(rel)))
    } catch (error) {
      throw mapError(error)
    }
  }

  async rmdir(rel: string): Promise<void> {
    this.requireWrites()
    await this.assertAncestry(rel)
    try {
      await fsp.rmdir(this.resolve(rel))
      await this.options.helper?.flushDirectory(path.dirname(this.resolve(rel)))
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
      await this.options.helper?.flushDirectory(path.dirname(this.resolve(dst)))
    } catch (error) {
      throw mapError(error)
    }
  }

  async unlink(rel: string): Promise<void> {
    this.requireWrites()
    await this.assertAncestry(rel)
    try {
      await fsp.unlink(this.resolve(rel))
      await this.options.helper?.flushDirectory(path.dirname(this.resolve(rel)))
    } catch (error) {
      throw mapError(error)
    }
  }
}
