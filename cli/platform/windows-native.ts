import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import type { ComponentFacts, PlatformHelper, RootMutex, VolumeFacts } from './helper.js'

interface Reply { id: number; ok: boolean; value?: unknown; error?: string }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

/** Real Win32 facts and mutex worker. This implementation alone is not a qualification pass.
 * The shipped mutation gate remains disabled until native acceptance is independently met.
 * A worker's EOF/parent-exit watchdog releases its OS mutex; there is no time-based lock theft.
 */
export class WindowsPlatformHelper implements PlatformHelper {
  // Explicit construction probes can qualify a disposable root; the shipped loader passes false.
  constructor(readonly mutationQualified = true) {}

  readonly available = process.platform === 'win32'
  readonly version = 'windows-pwsh-win32-v1'
  readonly unavailableReason = this.available ? null : 'The Win32 helper requires Windows and PowerShell 7.'
  private worker: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<number, Pending>()
  private sequence = 0
  private alive = false
  private failed: Error | null = null

  private start(): ChildProcessWithoutNullStreams {
    if (!this.available) throw new Error(this.unavailableReason ?? 'Unsupported platform')
    if (this.failed) throw this.failed
    if (this.worker) return this.worker
    // tsc does not copy non-TS resources. A local build resolves them from its source tree;
    // standalone packaging must explicitly include both worker files beside the emitted JS.
    const candidates = [new URL('./windows-worker.ps1', import.meta.url), new URL('../../../cli/platform/windows-worker.ps1', import.meta.url)]
    const resource = candidates.find((url) => existsSync(url))
    if (!resource) throw new Error('Native worker resources are missing; native writes refused.')
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(resource), '-ParentPid', String(process.pid)], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    })
    this.worker = child
    this.alive = true
    const fail = (error: Error): void => {
      this.failed = error
      this.alive = false
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
      this.pending.clear()
      this.unref()
    }
    child.on('error', (error) => fail(new Error(`Native helper failed: ${error.message}`)))
    child.on('exit', (code, signal) => fail(new Error(`Native helper lost (exit ${code}, signal ${signal}); halting.`)))
    // Never forward arbitrary worker stderr to user logs. Startup and RPC failures remain explicit.
    child.stderr.on('data', () => { /* drained; exit/timeout provides a bounded failure */ })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      try {
        if (Buffer.byteLength(line, 'utf8') > 256 * 1024) throw new Error('Oversized native helper response')
        const reply = JSON.parse(line) as Reply
        const p = this.pending.get(reply.id)
        if (!p || typeof reply.ok !== 'boolean') throw new Error('Unrecognized native helper response')
        clearTimeout(p.timer); this.pending.delete(reply.id)
        if (reply.ok) p.resolve(reply.value)
        else p.reject(new Error(`Native helper refused: ${reply.error ?? 'unknown failure'}`))
        if (!this.pending.size) this.unref()
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
    })
    this.unref()
    return child
  }

  private ref(): void {
    this.worker?.ref()
    for (const stream of [this.worker?.stdin, this.worker?.stdout, this.worker?.stderr]) {
      (stream as unknown as { ref?: () => void } | undefined)?.ref?.()
    }
  }
  private unref(): void {
    this.worker?.unref()
    for (const stream of [this.worker?.stdin, this.worker?.stdout, this.worker?.stderr]) {
      (stream as unknown as { unref?: () => void } | undefined)?.unref?.()
    }
  }

  private async request<T>(op: string, arg = ''): Promise<T> {
    const child = this.start()
    if (!this.alive || child.exitCode !== null || child.killed) throw new Error('Native helper lost; halting.')
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      this.ref()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.failed = new Error('Native helper timed out; native mutation disabled for this command.')
        this.alive = false
        child.stdin.end()
        reject(this.failed)
        if (!this.pending.size) this.unref()
      }, 30_000)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      child.stdin.write(`${JSON.stringify({ id, op, arg })}\n`, 'utf8', (error) => {
        if (error) {
          clearTimeout(timer); this.pending.delete(id); this.alive = false
          reject(new Error('Native helper communication failed; halting.'))
          if (!this.pending.size) this.unref()
        }
      })
    })
  }

  async volume(rootPath: string): Promise<VolumeFacts> { return this.request('volume', rootPath) }
  async components(rootPath: string): Promise<ComponentFacts[]> { return this.request('components', rootPath) }
  async fileId(fullPath: string): Promise<string> { return this.request('fileId', fullPath) }
  async processStart(pid: number): Promise<string | null> {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process ID')
    return this.request('processStart', String(pid))
  }
  async acquireRootMutex(rootId: string): Promise<RootMutex> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(rootId)) throw new Error('Unsafe root mutex identity')
    const name = await this.request<string>('acquire', rootId)
    let active = true
    return {
      name,
      held: () => active && this.alive && this.worker !== null && this.worker.exitCode === null && !this.worker.killed,
      assertHeld: async () => {
        if (!active || !this.alive || !await this.request<boolean>('held', name)) throw new Error('Root mutex ownership lost; halting.')
      },
      release: async () => {
        if (!active) return
        active = false
        if (!this.alive) throw new Error('Native helper lost before root mutex release')
        await this.request('release', name)
      },
    }
  }
  async flushDirectory(fullPath: string): Promise<void> { await this.request('flushDirectory', fullPath) }
  /** Ends this command's helper, releasing its mutex. Only this owned child is affected. */
  async close(): Promise<void> {
    if (!this.worker) return
    if (this.pending.size) throw new Error('Cannot close helper while operations are pending')
    this.alive = false
    this.worker.stdin.end()
  }
}
