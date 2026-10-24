// Consolidated trap registry (PLAN §10). Metadata only; the sandbox runner lives in
// src/adapters/trap-runner.ts and native cases run only under the explicit native harness.
// S = sandbox/pure, N = qualified native only, B = both, scored independently per profile.

export type TrapProfile = 'S' | 'N' | 'B'

export interface TrapDef {
  id: string
  title: string
  profile: TrapProfile
  expected: string
  whatBugThisCatches: string
}

export const TRAPS: TrapDef[] = [
  { id: 'T01', profile: 'B', title: 'Duplicate destination', expected: 'Two accepted rows with the same destination are blocked.', whatBugThisCatches: 'Second move silently overwriting or failing mid-plan.' },
  { id: 'T02', profile: 'B', title: 'Case/Unicode alias collision', expected: 'Destinations equal under case folding or NFC/NFKC are blocked.', whatBugThisCatches: 'Case-insensitive volumes merging two different files.' },
  { id: 'T03', profile: 'B', title: 'Occupied destination', expected: 'An existing file at the destination is never overwritten; the row is blocked.', whatBugThisCatches: 'Overwrite rename destroying an unrelated file.' },
  { id: 'T04', profile: 'B', title: 'Swaps, case-only and dependent moves', expected: 'Rows moving onto a path vacated by another selected row, swaps and case-only renames are blocked.', whatBugThisCatches: 'Order-dependent plans that half-apply.' },
  { id: 'T05', profile: 'B', title: 'Changed bytes, same size and mtime', expected: 'Apply halts before touching a file whose hash changed after approval.', whatBugThisCatches: 'Trusting size/mtime instead of the approved hash.' },
  { id: 'T06', profile: 'B', title: 'Missing source', expected: 'A vanished source halts the remaining operations and offers recovery.', whatBugThisCatches: 'Opportunistic continuation after a lost precondition.' },
  { id: 'T07', profile: 'B', title: 'Project subtree and protected names', expected: 'Project trees and README/LICENSE/.env/lock files are skipped and untouched.', whatBugThisCatches: 'Breaking a repository or leaking credential names into proposals.' },
  { id: 'T08', profile: 'B', title: 'Protected destination, parent-file, prefix conflict', expected: 'Destinations that are protected, under a file, or prefix another destination are blocked.', whatBugThisCatches: 'mkdir over a file or nesting a destination inside another.' },
  { id: 'T09', profile: 'B', title: 'Path syntax', expected: 'Traversal, drive, UNC, ADS, device, illegal and overlong names are rejected.', whatBugThisCatches: 'Escaping the root or creating unopenable names.' },
  { id: 'T10', profile: 'B', title: 'Literal percent source, encoded traversal', expected: 'Source %41.txt keeps its literal name; %2e%2e%2f proposals are rejected.', whatBugThisCatches: 'URL-decoding names into traversal or renaming literal files.' },
  { id: 'T11', profile: 'S', title: 'Strict proposal schema', expected: 'Unknown/duplicate ids, unknown categories, extra fields and extension changes are rejected.', whatBugThisCatches: 'Lenient parsing that lets a model smuggle paths.' },
  { id: 'T12', profile: 'S', title: 'Injection names', expected: 'Names and reasons containing markup or shell syntax are shown as text.', whatBugThisCatches: 'HTML or shell injection through file names or model reasons.' },
  { id: 'T13', profile: 'B', title: 'Scan and model overflow', expected: 'Scan bound overflow aborts with no approvable plan; model overflow/failure is visibly partial.', whatBugThisCatches: 'Silently truncated scans approved as complete.' },
  { id: 'T14', profile: 'B', title: 'Same size, different bytes; empty/unhashable', expected: 'Different bytes never group as duplicates; empty and unhashable files are reported.', whatBugThisCatches: 'Size-only duplicate detection quarantining unique files.' },
  { id: 'T15', profile: 'B', title: 'Interrupt each apply boundary', expected: 'Recovery restores the exact pre-apply byte/path manifest from every boundary.', whatBugThisCatches: 'Crash windows that lose or duplicate a file.' },
  { id: 'T16', profile: 'B', title: 'Linked-only state', expected: 'A failed unlink halts as needs_attention; recovery removes only the verified extra link.', whatBugThisCatches: 'Retrying unlink blindly or deleting the only copy.' },
  { id: 'T17', profile: 'B', title: 'Foreign destination after intent', expected: 'A foreign file appearing at the destination is preserved.', whatBugThisCatches: 'Recovery deleting a file it did not create.' },
  { id: 'T18', profile: 'B', title: 'Changed destination or reoccupied original', expected: 'Reverse is refused and both paths preserved.', whatBugThisCatches: 'Undo clobbering user edits.' },
  { id: 'T19', profile: 'B', title: 'Clear conflict and retry twice', expected: 'After a conflict is cleared, retry restores exactly once; a second retry is a no-op.', whatBugThisCatches: 'Double reversal from trusting log labels.' },
  { id: 'T20', profile: 'B', title: 'Interrupt each reverse boundary', expected: 'Recovery/undo interrupted at any boundary can be retried safely.', whatBugThisCatches: 'Non-idempotent reversal.' },
  { id: 'T21', profile: 'B', title: 'Torn tail vs corrupt record', expected: 'A torn final fragment is tolerated; a bad complete or interior record is needs_attention.', whatBugThisCatches: 'Treating corruption as an empty history.' },
  { id: 'T22', profile: 'B', title: 'Index rebuild', expected: 'Index rebuild is read-only; missing or ambiguous history blocks writes.', whatBugThisCatches: 'Guessing state after losing the index.' },
  { id: 'T23', profile: 'B', title: 'Imported or edited plan', expected: 'Imported, edited or sandbox plans need reconstruction and fresh approval.', whatBugThisCatches: 'Executing an untrusted plan file directly.' },
  { id: 'T24', profile: 'N', title: 'Concurrent owners', expected: 'Concurrent runs/recoveries and PID/token/lifecycle races admit one owner.', whatBugThisCatches: 'Two processes mutating one root.' },
  { id: 'T25', profile: 'N', title: 'Unsupported roots', expected: 'Network, sync, unsupported volume or identity roots are refused without write probes.', whatBugThisCatches: 'Running on OneDrive/UNC where link/identity semantics differ.' },
  { id: 'T26', profile: 'N', title: 'Junctions and cross-volume', expected: 'Junction or replaced ancestors and cross-volume targets are refused.', whatBugThisCatches: 'Writing outside the root through a reparse point.' },
  { id: 'T27', profile: 'N', title: 'Renamed or recreated root', expected: 'Renamed/remounted roots find their history; ambiguity refuses.', whatBugThisCatches: 'Losing unresolved runs or attaching them to the wrong root.' },
  { id: 'T28', profile: 'B', title: 'Newer quarantine blocks older undo', expected: 'Older organize undo is refused with a visible reason naming the newer run.', whatBugThisCatches: 'Undo crossing a later dependent run.' },
  { id: 'T29', profile: 'B', title: 'Restore collision', expected: 'Restore into an occupied original path preserves both; retry is explicit.', whatBugThisCatches: 'Restore overwriting a newer file.' },
  { id: 'T30', profile: 'S', title: 'Model failure', expected: 'Missing, malformed or timed-out model output never fabricates proposals or auto-applies.', whatBugThisCatches: 'Fake AI results or silent auto-apply.' },
  { id: 'T31', profile: 'N', title: 'Local bin round trip', expected: 'Local bin runs; the browser bundle excludes native imports.', whatBugThisCatches: 'Node APIs leaking into the web build.' },
  { id: 'T32', profile: 'S', title: 'Misleading double extension', expected: 'A basename carrying a known suffix (invoice.pdf for an .exe) is blocked until edited.', whatBugThisCatches: 'Disguising executables as documents.' },
  { id: 'T33', profile: 'S', title: 'Off-list category', expected: 'An unknown category is rejected, never mapped to Other.', whatBugThisCatches: 'Silent remapping of model output.' },
  { id: 'T34', profile: 'B', title: 'Output and quarantine excluded', expected: 'Later ordinary scans skip the output and quarantine roots.', whatBugThisCatches: 'Re-organizing already organized or quarantined files.' },
  { id: 'T35', profile: 'S', title: 'Edits invalidate approval', expected: 'Selection, category or output edits clear the approval.', whatBugThisCatches: 'Applying a plan that differs from the approved digest.' },
  { id: 'T36', profile: 'B', title: 'Operation budget', expected: 'The maximum plan budget counts mkdir, apply and reverse operations.', whatBugThisCatches: 'Fixed loop ceilings that stop recovery half way.' },
  { id: 'T37', profile: 'B', title: 'Created-directory cleanup', expected: 'Only directories proven created by the run and still empty are removed.', whatBugThisCatches: 'Deleting pre-existing or foreign folders.' },
  { id: 'T38', profile: 'N', title: 'Stale lock retirement', expected: 'Stale retirement cannot remove a successor lock; helper loss halts.', whatBugThisCatches: 'Check-then-unlink lock races.' },
  { id: 'T39', profile: 'B', title: 'Torn-tail continuation', expected: 'Continuation after a torn tail preserves evidence across another crash.', whatBugThisCatches: 'Appending after a fragment and creating interior corruption.' },
]

export const REQUIRED_TRAP_IDS: string[] = TRAPS.map((t) => t.id)
