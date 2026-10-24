import { checkProposedBasename, splitExtension } from './paths.js'

// Proposal v1 (PLAN §5). A model or the heuristic suggests only a trusted category id and a
// basename without extension. Code builds the destination and reattaches the exact original
// suffix. Anything off-contract is rejected visibly; nothing is mapped, stripped or decoded.

export interface CategoryDef {
  id: string
  folder: string
  extensions: string[]
}

export const CATEGORIES: CategoryDef[] = [
  { id: 'documents', folder: 'Documents', extensions: ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt', '.pages', '.epub'] },
  { id: 'images', folder: 'Images', extensions: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.tif', '.tiff', '.svg', '.raw'] },
  { id: 'audio', folder: 'Audio', extensions: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma'] },
  { id: 'video', folder: 'Video', extensions: ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.m4v'] },
  { id: 'archives', folder: 'Archives', extensions: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz'] },
  { id: 'installers', folder: 'Installers', extensions: ['.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.appimage', '.apk'] },
  { id: 'code', folder: 'Code', extensions: ['.py', '.js', '.ts', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.ps1', '.html', '.css', '.json', '.xml', '.yml', '.yaml', '.sql'] },
  { id: 'spreadsheets', folder: 'Spreadsheets', extensions: ['.xls', '.xlsx', '.csv', '.ods', '.numbers', '.tsv'] },
  { id: 'presentations', folder: 'Presentations', extensions: ['.ppt', '.pptx', '.key', '.odp'] },
  { id: 'other', folder: 'Other', extensions: [] },
]

const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]))
const KNOWN_EXTENSIONS = new Set(CATEGORIES.flatMap((c) => c.extensions))

export function categoryById(id: string): CategoryDef | undefined {
  return CATEGORY_BY_ID.get(id)
}

/** Trusted local categorization by exact extension (case-insensitive). Null when unknown. */
export function categoryForExtension(ext: string): CategoryDef | null {
  const lower = ext.toLowerCase()
  if (!lower) return null
  return CATEGORIES.find((c) => c.extensions.includes(lower)) ?? null
}

/** A basename whose own final suffix is a known extension (invoice.pdf) is misleading. */
export function hasKnownSuffix(basename: string): boolean {
  const { ext } = splitExtension(basename)
  return ext !== '' && KNOWN_EXTENSIONS.has(ext.toLowerCase())
}

export interface ProposalItem {
  fileId: string
  categoryId: string
  basename: string
  confidence: number
  reason: string
}

export interface RejectedProposal {
  index: number
  fileId: string | null
  code: string
  reason: string
}

export interface ParsedProposals {
  accepted: ProposalItem[]
  rejected: RejectedProposal[]
  /** Set when the whole response is unusable; then accepted is empty. */
  fatal: string | null
}

export const PROPOSAL_LIMITS = {
  maxItems: 500,
  maxReason: 200,
  maxResponseBytes: 64 * 1024,
}

const ITEM_KEYS = ['basename', 'categoryId', 'confidence', 'fileId', 'reason']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((k, i) => k === expected[i])
}

/** Parse response text with a byte bound before JSON.parse. */
export function parseProposalText(text: string, fileIds: ReadonlySet<string>): ParsedProposals {
  if (text.length > PROPOSAL_LIMITS.maxResponseBytes) {
    return { accepted: [], rejected: [], fatal: `Response larger than ${PROPOSAL_LIMITS.maxResponseBytes} bytes.` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { accepted: [], rejected: [], fatal: 'Response is not valid JSON.' }
  }
  return parseProposalResponse(raw, fileIds)
}

export function parseProposalResponse(raw: unknown, fileIds: ReadonlySet<string>): ParsedProposals {
  if (!isPlainObject(raw) || !exactKeys(raw, ['proposals'])) {
    return { accepted: [], rejected: [], fatal: 'Top level must contain exactly one field: proposals.' }
  }
  const list = raw.proposals
  if (!Array.isArray(list)) return { accepted: [], rejected: [], fatal: 'proposals must be an array.' }
  if (list.length > PROPOSAL_LIMITS.maxItems) {
    return { accepted: [], rejected: [], fatal: `More than ${PROPOSAL_LIMITS.maxItems} proposals.` }
  }

  const rejected: RejectedProposal[] = []
  const candidates: { index: number; item: ProposalItem }[] = []
  const idCounts = new Map<string, number>()

  list.forEach((entry, index) => {
    const fileId = isPlainObject(entry) && typeof entry.fileId === 'string' ? entry.fileId : null
    const reject = (code: string, reason: string): void => {
      rejected.push({ index, fileId, code, reason })
    }
    // Count every occurrence of an id, including malformed ones, so a valid item cannot win
    // over a contradictory second proposal for the same file.
    if (fileId !== null) idCounts.set(fileId, (idCounts.get(fileId) ?? 0) + 1)
    if (!isPlainObject(entry)) return reject('not-object', 'Proposal is not an object.')
    if (!exactKeys(entry, ITEM_KEYS)) return reject('fields', 'Proposal must have exactly fileId, categoryId, basename, confidence, reason.')
    if (fileId === null || !fileIds.has(fileId)) return reject('unknown-file', 'Unknown file id.')
    const { categoryId, basename, confidence, reason } = entry
    if (typeof categoryId !== 'string' || !CATEGORY_BY_ID.has(categoryId)) {
      return reject('unknown-category', `Category ${JSON.stringify(String(categoryId)).slice(0, 60)} is not on the trusted list.`)
    }
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return reject('confidence', 'Confidence must be a finite number from 0 to 1.')
    }
    if (typeof reason !== 'string' || reason.length > PROPOSAL_LIMITS.maxReason) {
      return reject('reason', `Reason must be a string of at most ${PROPOSAL_LIMITS.maxReason} characters.`)
    }
    if (typeof basename !== 'string') return reject('basename', 'Basename must be a string.')
    const nameCheck = checkProposedBasename(basename)
    if (!nameCheck.ok) return reject(nameCheck.code, `Basename rejected: ${nameCheck.reason}.`)
    candidates.push({ index, item: { fileId, categoryId, basename, confidence, reason } })
  })

  const accepted: ProposalItem[] = []
  for (const { index, item } of candidates) {
    if ((idCounts.get(item.fileId) ?? 0) > 1) {
      rejected.push({ index, fileId: item.fileId, code: 'duplicate-id', reason: 'The same file id appears more than once.' })
    } else {
      accepted.push(item)
    }
  }
  return { accepted, rejected: rejected.sort((a, b) => a.index - b.index), fatal: null }
}
