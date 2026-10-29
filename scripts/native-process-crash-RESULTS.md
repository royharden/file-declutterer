# Real process-crash author sweep — partial, stopped by parent

Author: `0767_Codex_GPT-61Sol_Sub_NativeHelper`, parent S13-INT `0765`.

Candidate: `e5e6fa79e9f4a67b65c2cb9e72a6d1b222156b77`. Command: `node scripts/native-process-crash.mjs`, from `C:\Worktrees\Bolt.New\file-declutterer\FULL-INT`, Node `v24.18.0`, Windows, helper `windows-pwsh-win32-v1`, disposable unmanaged C: NTFS fixtures only.

**Not complete; not independent acceptance.** Parent relayed Roy/RV's instruction to stop duplicate heavy author testing while RV's independent 25-boundary requalification runs. The author runner was stopped after case 15 was saved; fixture setup for case 16 had begun, but no owned child remained at the stop checks. The remaining 46 planned cases are **NOT RUN**.

## Exact evidence

Durable machine-readable evidence and preserved fixtures:

`C:\Users\Roy Harden\AppData\Local\Temp\s13-native-process-crash-0qr8Zr\evidence.json`

| Observation | Count / result |
|---|---|
| Discovered apply checkpoints | 18 |
| Discovered ordinary undo checkpoints | 19 |
| Discovered linked-only rollback checkpoints | 18 |
| Additional planned torn/corruption/foreign-conflict cases | 6 |
| Planned total cases | 61 |
| Completed crash cases | **15 PASS** — all in the apply sweep |
| Product cases failed during completed work | 0 |
| Remaining cases | **46 NOT RUN** |
| Actual owned child process crash injections | 16 — 15 swept cases plus one discovery seed |
| Operator-directed runner stops | 1 — separate from crash injections |
| Healthy discovery journeys | Apply, undo and linked-only rollback completed |
| Final emitted/helper/harness SHA-256 comparison | All captured fingerprints match at stop |

The harness captured SHA-256 fingerprints of every emitted CLI/core JavaScript file, helper C#/PowerShell resources and its own source before execution. A separate stop receipt recomputed that exact list after stopping the runner; no difference was found. The complete per-file hashes are in `evidence.json`.

The 15 swept checkpoints, in execution order:

1. `store:plan:before`
2. `store:plan:after`
3. `after-begin`
4. `apply:0:before-intent`
5. `apply:0:after-intent`
6. `apply:0:after-mutation`
7. `apply:0:after-outcome`
8. `apply:1:before-intent`
9. `apply:1:after-intent`
10. `apply:1:after-mutation`
11. `apply:1:after-outcome`
12. `apply:2:before-intent`
13. `apply:2:after-intent`
14. `apply:2:after-link`
15. `apply:2:after-mutation`

Every completed case used a real `WindowsPlatformHelper`, qualified helper identities in `NodeFs`, `FileJournalStore(helper)`, private-state ACL creation/checks, actual directory flushes, an OS root mutex and root LOCK. The child synchronously wrote an exact checkpoint marker and blocked; the parent terminated only that owned `ChildProcess` with `SIGKILL` (Windows process termination), then launched a fresh child for recovery and another fresh child for retry. No `InterruptError` was used or counted as process death.

The independent oracle compared raw file bytes encoded as hex at their exact relative file paths, including an unselected foreign synthetic file, protected README and protected project source. Completed recoveries preserved that file manifest. Empty directories whose creation was not proven by an outcome record could conservatively remain; directory retention is reported per case and is not called exact directory-tree restoration.

The `store:plan:after` case correctly returned `needs_attention` because no first journal record existed. A fresh retry preserved the raw files and returned the same refusal; the harness explicitly asserted that `journal.jsonl` remained absent. It never manufactured genesis history to force recovery success. This expected safe refusal counts as the case's pass, not successful reversal.

## Stop disposition

- Owned runner PID `35216` was checked against its exact harness command line and stopped at `2026-10-26T22:37:30.6802352-04:00`.
- No owned active Node child was found in the runner-child snapshot or the post-stop runner-child check. No unrelated process was stopped.
- Exec session `49458` completed with exit code 1 because of the directed runner stop. This is not recorded as a product-test failure.
- Preserved fixtures include `001`–`003` discovery journeys, `004`–`018` completed cases and `019-apply-16` incomplete fixture setup. Nothing was cleaned up or reassociated after stopping.
- Parent alone owns Git staging/commits. This child did not compile shared output, edit product/RV-owned files, or change the default native-mutation gate.

## Not run and limitations

The three remaining apply checkpoints (`apply:2:after-outcome` and before/after committed status), all 19 undo crash points, all 18 linked-only rollback crash points, four torn-tail continuation second-crash points, complete-corruption refusal and foreign-original conflict/retry remain unrun in this author sweep. Their authored harness code is not execution evidence. Healthy reverse discovery does not substitute for a completed reverse crash sweep.

This is one small organize plan on a disposable C: NTFS root, with two created directories and one moved file. It does not establish maximum-plan behavior, power-loss durability, hostile-writer safety, every volume/platform/alias condition, or complete native qualification. RV's independent candidate-bound tests remain the acceptance authority. Await parent regrant before further heavy author execution.
