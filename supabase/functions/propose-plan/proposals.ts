import { extensionOf, isUnderReserved, normalizeRelative } from './pathSafety.ts'

export interface Proposal {
  from: string
  to: string
}

export interface RejectedProposal {
  from: string
  reason: string
}

export interface AcceptedProposals {
  proposals: Proposal[]
  rejected: RejectedProposal[]
  contractError?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const raw = fenced?.[1] ?? trimmed
  return JSON.parse(raw) as unknown
}

export function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (isRecord(part) && typeof part.text === 'string') return part.text
      return ''
    })
    .join('')
}

export function acceptProposals(eligiblePaths: string[], modelJson: unknown): AcceptedProposals {
  if (!isRecord(modelJson)) {
    return { proposals: [], rejected: [], contractError: 'Model response was not a JSON object.' }
  }
  const topKeys = Object.keys(modelJson)
  if (topKeys.some((key) => key !== 'proposals')) {
    return {
      proposals: [],
      rejected: [],
      contractError: 'Model response included a field other than proposals.',
    }
  }
  if (!Array.isArray(modelJson.proposals)) {
    return {
      proposals: [],
      rejected: [],
      contractError: 'Model response did not include a proposals array.',
    }
  }

  const eligible = new Set(eligiblePaths)
  const proposals: Proposal[] = []
  const rejected: RejectedProposal[] = []
  const claimed = new Set<string>()

  for (const item of modelJson.proposals) {
    if (!isRecord(item)) {
      rejected.push({ from: '', reason: 'A proposal was not an object.' })
      continue
    }
    if (Object.keys(item).some((key) => key !== 'from' && key !== 'to')) {
      const from = typeof item.from === 'string' ? item.from : ''
      rejected.push({ from, reason: 'A proposal included a field other than from and to.' })
      continue
    }
    if (typeof item.from !== 'string' || typeof item.to !== 'string') {
      rejected.push({ from: '', reason: 'from and to must be strings.' })
      continue
    }
    if (!eligible.has(item.from)) {
      rejected.push({ from: item.from, reason: 'That path was not in the eligible set.' })
      continue
    }
    const dest = normalizeRelative(item.to)
    if (!dest.ok) {
      rejected.push({ from: item.from, reason: dest.reason })
      continue
    }
    if (isUnderReserved(dest.path)) {
      rejected.push({ from: item.from, reason: 'System folders are not organize destinations.' })
      continue
    }
    if (extensionOf(item.from) !== extensionOf(dest.path)) {
      rejected.push({ from: item.from, reason: 'The extension must stay the same.' })
      continue
    }
    const key = dest.path.toLowerCase()
    if (claimed.has(key)) {
      rejected.push({ from: item.from, reason: 'Another proposal already uses that path, ignoring case.' })
      continue
    }
    claimed.add(key)
    proposals.push({ from: item.from, to: dest.path })
  }

  return { proposals, rejected }
}
