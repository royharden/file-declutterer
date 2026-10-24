import { randomBytes } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { PlatformHelper, RootMutex } from './platform/helper.js'

// One root-level boundary for discovery, registration, begin, apply, recovery, undo and
// restore (PLAN §7). LOCK lives at <state>\<rootId>\LOCK, never per run.
//
// Reviewer correction applied: reading a token and then unlinking it is not atomic against a
// successor. Every inspect/acquire/retire/remove of LOCK therefore happens while holding the
// platform root mutex, which is held for the whole command. Without a qualified helper the
// mutex cannot be acquired and native writes are refused; there is no unguarded fallback and
// no timeout-based theft.

export interface LockOwner {
  token: string
  rootId: string
  host: string
  pid: number
  processStart: string
  acquiredAt: string
}

export interface RootLock {
  owner: LockOwner
  /** Throws unless the mutex is still held and LOCK still names this owner. */
  assert(): Promise<void>
  release(): Promise<void>
  retired: LockOwner | null
}

export class LockRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LockRefused'
  }
}

async function readOwner(file: string): Promise<LockOwner | 'absent' | 'unreadable'> {
  let text: string
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'
  }
  try {
    const parsed = JSON.parse(text) as LockOwner
    if (typeof parsed.token !== 'string' || typeof parsed.pid !== 'number') return 'unreadable'
    return parsed
  } catch {
    return 'unreadable'
  }
}

export async function acquireRootLock(stateDir: string, rootId: string, helper: PlatformHelper, now: () => string = () => new Date().toISOString()): Promise<RootLock> {
  if (!helper.available) throw new LockRefused(helper.unavailableReason ?? 'Platform helper unavailable; cannot guard the root lock.')
  const mutex: RootMutex = await helper.acquireRootMutex(rootId)
  const file = path.join(stateDir, 'LOCK')
  let retired: LockOwner | null = null
  try {
    const existing = await readOwner(file)
    if (existing === 'unreadable') throw new LockRefused('LOCK exists but cannot be read; resolve it manually.')
    if (existing !== 'absent') {
      if (existing.rootId !== rootId) throw new LockRefused('LOCK belongs to a different root identity.')
      if (existing.host !== os.hostname()) throw new LockRefused(`LOCK is held by host ${existing.host}; cannot verify that process.`)
      const start = await helper.processStart(existing.pid)
      if (start === null) {
        // Owner process is gone. Still under the mutex: re-read to be sure it is the same marker.
        const again = await readOwner(file)
        if (again === 'absent' || again === 'unreadable' || again.token !== existing.token) throw new LockRefused('LOCK changed during inspection.')
        await fsp.rename(file, path.join(stateDir, `LOCK.retired-${existing.token.slice(0, 8)}-${Date.now()}`))
        retired = existing
      } else if (start === existing.processStart) {
        throw new LockRefused(`Root is in use by process ${existing.pid} (since ${existing.acquiredAt}).`)
      } else {
        throw new LockRefused('LOCK names a process id now used by a different process; verify and resolve manually.')
      }
    }
    const processStart = await helper.processStart(process.pid)
    if (processStart === null) throw new LockRefused('Cannot verify this process identity.')
    const owner: LockOwner = { token: randomBytes(16).toString('hex'), rootId, host: os.hostname(), pid: process.pid, processStart, acquiredAt: now() }
    const handle = await fsp.open(file, 'wx')
    try {
      await handle.writeFile(JSON.stringify(owner), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await helper.flushDirectory(stateDir)

    const assert = async (): Promise<void> => {
      if (!mutex.held()) throw new LockRefused('Root mutex lost; halting.')
      const current = await readOwner(file)
      if (current === 'absent' || current === 'unreadable' || current.token !== owner.token) throw new LockRefused('Root LOCK no longer names this process; halting.')
    }
    const release = async (): Promise<void> => {
      try {
        if (mutex.held()) {
          const current = await readOwner(file)
          if (current !== 'absent' && current !== 'unreadable' && current.token === owner.token) await fsp.unlink(file)
        }
      } finally {
        await mutex.release()
      }
    }
    return { owner, assert, release, retired }
  } catch (error) {
    await mutex.release()
    throw error
  }
}
