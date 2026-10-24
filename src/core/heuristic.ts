import { splitExtension } from './paths.js'
import { categoryForExtension, type ProposalItem } from './proposal-schema.js'
import type { ScanManifest } from './types.js'

// Heuristic proposer: categorizes by known extension and keeps the original stem. It is not AI
// and is labelled "Heuristic" everywhere. Unknown extensions go to Other with low confidence,
// which starts the row as a warning (unselected).

export const HEURISTIC_KNOWN_CONFIDENCE = 0.9
export const HEURISTIC_UNKNOWN_CONFIDENCE = 0.3

export function heuristicProposals(scan: ScanManifest): ProposalItem[] {
  return scan.files.map((file) => {
    const base = file.relPath.slice(file.relPath.lastIndexOf('/') + 1)
    const { stem } = splitExtension(base)
    const category = categoryForExtension(file.ext)
    return category
      ? {
          fileId: file.id,
          categoryId: category.id,
          basename: stem,
          confidence: HEURISTIC_KNOWN_CONFIDENCE,
          reason: `Extension ${file.ext} is a known ${category.folder.toLowerCase()} type.`,
        }
      : {
          fileId: file.id,
          categoryId: 'other',
          basename: stem,
          confidence: HEURISTIC_UNKNOWN_CONFIDENCE,
          reason: file.ext ? `Extension ${file.ext} is not recognized.` : 'File has no extension.',
        }
  })
}

/** Rows that Smart mode would send to an optional local model: unknown or missing extensions. */
export function ambiguousFileIds(scan: ScanManifest): string[] {
  return scan.files.filter((file) => categoryForExtension(file.ext) === null).map((file) => file.id)
}
