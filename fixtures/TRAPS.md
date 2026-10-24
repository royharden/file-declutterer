# Safety traps

Generated from `src/core/traps.ts`, which is the source of truth. Profile: S = sandbox/pure, N = qualified native only, B = both, scored independently per profile.

No result is recorded here. Sandbox cases run in the browser (Traps tab) and under `npm test` (`tests/contract/traps.test.ts`). Native cases need the disposable-root native harness (`npm run test:native`). As of 2026-10-23 nothing has been executed.

| ID | Profile | Case | Expected observation | what_bug_this_catches |
|---|---|---|---|---|
| T01 | B | Duplicate destination | Two accepted rows with the same destination are blocked. | Second move silently overwriting or failing mid-plan. |
| T02 | B | Case/Unicode alias collision | Destinations equal under case folding or NFC/NFKC are blocked. | Case-insensitive volumes merging two different files. |
| T03 | B | Occupied destination | An existing file at the destination is never overwritten; the row is blocked. | Overwrite rename destroying an unrelated file. |
| T04 | B | Swaps, case-only and dependent moves | Rows moving onto a path vacated by another selected row, swaps and case-only renames are blocked. | Order-dependent plans that half-apply. |
| T05 | B | Changed bytes, same size and mtime | Apply halts before touching a file whose hash changed after approval. | Trusting size/mtime instead of the approved hash. |
| T06 | B | Missing source | A vanished source halts the remaining operations and offers recovery. | Opportunistic continuation after a lost precondition. |
| T07 | B | Project subtree and protected names | Project trees and README/LICENSE/.env/lock files are skipped and untouched. | Breaking a repository or leaking credential names into proposals. |
| T08 | B | Protected destination, parent-file, prefix conflict | Destinations that are protected, under a file, or prefix another destination are blocked. | mkdir over a file or nesting a destination inside another. |
| T09 | B | Path syntax | Traversal, drive, UNC, ADS, device, illegal and overlong names are rejected. | Escaping the root or creating unopenable names. |
| T10 | B | Literal percent source, encoded traversal | Source %41.txt keeps its literal name; %2e%2e%2f proposals are rejected. | URL-decoding names into traversal or renaming literal files. |
| T11 | S | Strict proposal schema | Unknown/duplicate ids, unknown categories, extra fields and extension changes are rejected. | Lenient parsing that lets a model smuggle paths. |
| T12 | S | Injection names | Names and reasons containing markup or shell syntax are shown as text. | HTML or shell injection through file names or model reasons. |
| T13 | B | Scan and model overflow | Scan bound overflow aborts with no approvable plan; model overflow/failure is visibly partial. | Silently truncated scans approved as complete. |
| T14 | B | Same size, different bytes; empty/unhashable | Different bytes never group as duplicates; empty and unhashable files are reported. | Size-only duplicate detection quarantining unique files. |
| T15 | B | Interrupt each apply boundary | Recovery restores the exact pre-apply byte/path manifest from every boundary. | Crash windows that lose or duplicate a file. |
| T16 | B | Linked-only state | A failed unlink halts as needs_attention; recovery removes only the verified extra link. | Retrying unlink blindly or deleting the only copy. |
| T17 | B | Foreign destination after intent | A foreign file appearing at the destination is preserved. | Recovery deleting a file it did not create. |
| T18 | B | Changed destination or reoccupied original | Reverse is refused and both paths preserved. | Undo clobbering user edits. |
| T19 | B | Clear conflict and retry twice | After a conflict is cleared, retry restores exactly once; a second retry is a no-op. | Double reversal from trusting log labels. |
| T20 | B | Interrupt each reverse boundary | Recovery/undo interrupted at any boundary can be retried safely. | Non-idempotent reversal. |
| T21 | B | Torn tail vs corrupt record | A torn final fragment is tolerated; a bad complete or interior record is needs_attention. | Treating corruption as an empty history. |
| T22 | B | Index rebuild | Index rebuild is read-only; missing or ambiguous history blocks writes. | Guessing state after losing the index. |
| T23 | B | Imported or edited plan | Imported, edited or sandbox plans need reconstruction and fresh approval. | Executing an untrusted plan file directly. |
| T24 | N | Concurrent owners | Concurrent runs/recoveries and PID/token/lifecycle races admit one owner. | Two processes mutating one root. |
| T25 | N | Unsupported roots | Network, sync, unsupported volume or identity roots are refused without write probes. | Running on OneDrive/UNC where link/identity semantics differ. |
| T26 | N | Junctions and cross-volume | Junction or replaced ancestors and cross-volume targets are refused. | Writing outside the root through a reparse point. |
| T27 | N | Renamed or recreated root | Renamed/remounted roots find their history; ambiguity refuses. | Losing unresolved runs or attaching them to the wrong root. |
| T28 | B | Newer quarantine blocks older undo | Older organize undo is refused with a visible reason naming the newer run. | Undo crossing a later dependent run. |
| T29 | B | Restore collision | Restore into an occupied original path preserves both; retry is explicit. | Restore overwriting a newer file. |
| T30 | S | Model failure | Missing, malformed or timed-out model output never fabricates proposals or auto-applies. | Fake AI results or silent auto-apply. |
| T31 | N | Local bin round trip | Local bin runs; the browser bundle excludes native imports. | Node APIs leaking into the web build. |
| T32 | S | Misleading double extension | A basename carrying a known suffix (invoice.pdf for an .exe) is blocked until edited. | Disguising executables as documents. |
| T33 | S | Off-list category | An unknown category is rejected, never mapped to Other. | Silent remapping of model output. |
| T34 | B | Output and quarantine excluded | Later ordinary scans skip the output and quarantine roots. | Re-organizing already organized or quarantined files. |
| T35 | S | Edits invalidate approval | Selection, category or output edits clear the approval. | Applying a plan that differs from the approved digest. |
| T36 | B | Operation budget | The maximum plan budget counts mkdir, apply and reverse operations. | Fixed loop ceilings that stop recovery half way. |
| T37 | B | Created-directory cleanup | Only directories proven created by the run and still empty are removed. | Deleting pre-existing or foreign folders. |
| T38 | N | Stale lock retirement | Stale retirement cannot remove a successor lock; helper loss halts. | Check-then-unlink lock races. |
| T39 | B | Torn-tail continuation | Continuation after a torn tail preserves evidence across another crash. | Appending after a fragment and creating interior corruption. |
