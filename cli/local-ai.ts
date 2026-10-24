import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { splitExtension } from '../src/core/paths.js'
import { CATEGORIES, parseProposalText, type ParsedProposals, type ProposalItem, type RejectedProposal } from '../src/core/proposal-schema.js'
import type { FileRecord } from '../src/core/types.js'

// Optional local model adapter (PLAN §5). CLI only; loopback only. The request uses the
// OpenAI-compatible chat-completions shape that local servers such as Ollama expose at
// <base>/v1/chat/completions. That protocol choice is NOT yet verified against official
// documentation (deferred item); until DECLUTTER_MODEL_URL and DECLUTTER_MODEL_NAME are set the
// CLI says "Local AI not configured" and heuristic mode works alone. No cloud fallback, no
// retries, no model installation, no paid call.

export const LOCAL_AI_LIMITS = {
  maxRowsPerBatch: 80,
  maxRequestBytes: 32 * 1024,
  maxResponseBytes: 64 * 1024,
  attemptMs: 30_000,
  maxAttempts: 7,
  passMs: 240_000,
  maxFolderContext: 60,
}

export interface LocalAiConfig {
  endpoint: URL
  model: string
}

export type ConfigResult = { ok: true; config: LocalAiConfig } | { ok: false; reason: string }

function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith('127.')
  if (isIP(address) === 6) return address === '::1' || address === '0:0:0:0:0:0:0:1'
  return false
}

export function readLocalAiConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const rawUrl = env.DECLUTTER_MODEL_URL?.trim() ?? ''
  const model = env.DECLUTTER_MODEL_NAME?.trim() ?? ''
  if (!rawUrl || !model) return { ok: false, reason: 'Local AI not configured' }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'DECLUTTER_MODEL_URL is not a valid URL.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'DECLUTTER_MODEL_URL must be http or https.' }
  if (url.username || url.password) return { ok: false, reason: 'DECLUTTER_MODEL_URL must not embed credentials.' }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host !== 'localhost' && !isLoopbackAddress(host)) return { ok: false, reason: 'DECLUTTER_MODEL_URL must point at this machine (loopback only).' }
  if (model.length > 200) return { ok: false, reason: 'DECLUTTER_MODEL_NAME is too long.' }
  const base = url.pathname.replace(/\/+$/, '')
  const endpoint = new URL(base.endsWith('/v1/chat/completions') ? base : `${base}/v1/chat/completions`, url)
  return { ok: true, config: { endpoint, model } }
}

/** Every address the host resolves to must be loopback; checked again before each attempt. */
export async function assertLoopback(endpoint: URL): Promise<void> {
  const host = endpoint.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (!isLoopbackAddress(host)) throw new Error('Model endpoint is not loopback.')
    return
  }
  const addresses = await lookup(host, { all: true })
  if (addresses.length === 0 || !addresses.every((a) => isLoopbackAddress(a.address))) {
    throw new Error(`Model host ${host} resolves to a non-loopback address.`)
  }
}

export interface DisclosureItem {
  fileId: string
  basename: string
  extension: string
  folder: string
}

/** Exactly what would be sent: opaque id, basename, extension and a bounded folder name. */
export function disclosureFor(files: FileRecord[]): DisclosureItem[] {
  return files.map((file) => {
    const slash = file.relPath.lastIndexOf('/')
    const base = file.relPath.slice(slash + 1)
    const parent = slash < 0 ? '' : file.relPath.slice(0, slash)
    const folder = parent.slice(parent.lastIndexOf('/') + 1).slice(0, LOCAL_AI_LIMITS.maxFolderContext)
    return { fileId: file.id, basename: splitExtension(base).stem, extension: file.ext, folder }
  })
}

const SYSTEM_PROMPT = [
  'You organize files by name only. You never see file contents.',
  `For each item choose one categoryId from: ${CATEGORIES.map((c) => c.id).join(', ')}.`,
  'Suggest a clear basename WITHOUT any extension or path separators.',
  'Reply with JSON only, exactly: {"proposals":[{"fileId":"...","categoryId":"...","basename":"...","confidence":0.0,"reason":"..."}]}.',
  'Use each fileId once. confidence is 0..1. reason is at most 200 characters.',
].join(' ')

function requestBody(model: string, batch: DisclosureItem[]): string {
  return JSON.stringify({
    model,
    stream: false,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ items: batch }) },
    ],
  })
}

export function planBatches(model: string, items: DisclosureItem[]): DisclosureItem[][] {
  const batches: DisclosureItem[][] = []
  let current: DisclosureItem[] = []
  for (const item of items) {
    const candidate = [...current, item]
    if (candidate.length > LOCAL_AI_LIMITS.maxRowsPerBatch || Buffer.byteLength(requestBody(model, candidate)) > LOCAL_AI_LIMITS.maxRequestBytes) {
      if (current.length === 0) {
        batches.push([item])
        current = []
      } else {
        batches.push(current)
        current = [item]
      }
    } else {
      current = candidate
    }
  }
  if (current.length > 0) batches.push(current)
  return batches
}

export interface BatchOutcome {
  index: number
  rows: number
  status: 'ok' | 'failed' | 'unattempted'
  detail: string
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new Error(`Response larger than ${limit} bytes.`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Sequential batches, one attempt each, no retries. Valid completed batches keep their
 * proposals; failed and unattempted batches stay without proposals and the pass is visibly
 * partial. Nothing is applied automatically.
 */
export async function runLocalAi(
  config: LocalAiConfig,
  items: DisclosureItem[],
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<{ parsed: ParsedProposals; batches: BatchOutcome[]; partial: boolean }> {
  const batches = planBatches(config.model, items)
  const outcomes: BatchOutcome[] = []
  const accepted: ProposalItem[] = []
  const rejected: RejectedProposal[] = []
  const started = now()
  let offset = 0
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!
    const remaining = LOCAL_AI_LIMITS.passMs - (now() - started)
    if (i >= LOCAL_AI_LIMITS.maxAttempts || remaining <= 0) {
      outcomes.push({ index: i, rows: batch.length, status: 'unattempted', detail: i >= LOCAL_AI_LIMITS.maxAttempts ? 'Attempt limit reached.' : 'Pass time limit reached.' })
      offset += batch.length
      continue
    }
    try {
      await assertLoopback(config.endpoint)
      const response = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody(config.model, batch),
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(LOCAL_AI_LIMITS.attemptMs, remaining)),
      })
      if (response.status >= 300 && response.status < 400) throw new Error('Redirects are refused.')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await readBounded(response, LOCAL_AI_LIMITS.maxResponseBytes)
      const envelope = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }
      const content = envelope.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('Response has no message content.')
      const parsed = parseProposalText(content, new Set(batch.map((b) => b.fileId)))
      if (parsed.fatal) throw new Error(parsed.fatal)
      accepted.push(...parsed.accepted)
      rejected.push(...parsed.rejected.map((r) => ({ ...r, index: r.index + offset })))
      outcomes.push({ index: i, rows: batch.length, status: 'ok', detail: `${parsed.accepted.length} accepted, ${parsed.rejected.length} rejected.` })
    } catch (error) {
      outcomes.push({ index: i, rows: batch.length, status: 'failed', detail: error instanceof Error ? error.message : String(error) })
    }
    offset += batch.length
  }
  const partial = outcomes.some((o) => o.status !== 'ok')
  return { parsed: { accepted, rejected, fatal: null }, batches: outcomes, partial }
}
