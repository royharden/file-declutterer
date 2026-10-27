# Native integration construction receipt

Author: 0769_Codex_GPT-61Sol_Sub_S13-NativeIntegration, 2026-10-26. Uncommitted shared INT worktree; parent owns commits. This is construction evidence, not independent acceptance.

Changed `cli/node-fs.ts`, `qualify.ts`, `state.ts`, `lock.ts`, and `main.ts`. Added `scripts/native-integration-contract.mjs`. The default platform-helper loader remains unavailable; the shipped CLI still refuses native mutations.

- Optional helper injection uses full Win32 128-bit file identities consistently for root IDs and file observations, inspects existing ancestry before reads/hashing/mutations, rejects reparse/cloud or cross-volume paths, and flushes directories after metadata mutations.
- Qualified commands retain the root mutex/LOCK across registration, history discovery, scans, validation and mutation. Fresh asynchronous guard assertions precede guarded actions. LOCK parsing rejects corrupt/path-bearing tokens.
- Qualified private state secures new directories to the current user and validates existing ownership/allow rules. Directory metadata flushes use the helper. State paths refuse links and multiply-linked files. Unknown directory-enumeration errors do not mean empty history. Corrupt root registrations remain preserved and block replacement.
- Existing portable tests can omit the optional helper. Provisional Node root IDs and qualified helper root IDs intentionally differ; existing path hints cause a conservative ambiguity refusal instead of an automatic identity migration.

Executed: `node node_modules/typescript/bin/tsc -p tsconfig.cli.json` followed by `node scripts/native-integration-contract.mjs`: PASS. The probe used synthetic files and injected fake helper facts, independently checked Node crypto bytes, and passed helper identity, cloud/volume refusal before mutation, hardlink identity, four directory flushes, fresh guard loss, corrupt LOCK refusal, corrupt root registration preservation, and linked-plan refusal. Its selected inbox and private state were separate directories under one probe-created temporary sandbox; cleanup checked the exact sandbox parent and prefix.

Final post-edit checks: `node node_modules/typescript/bin/tsc -p tsconfig.cli.json --noEmit` and `git diff --check -- cli/node-fs.ts cli/qualify.ts cli/state.ts cli/lock.ts cli/main.ts`: exit 0.

Real Windows ACL execution is unverified. Real helper aliases/reparse/process-death/lifecycle races and all journal/process crash boundaries still require independent qualified-native acceptance. A fake helper cannot pass those gates. No production file movement, network/model call, credential read, publication, or commit was performed by this child.
