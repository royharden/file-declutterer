# File Declutterer

A review-first file organizer. A heuristic (or, in the local CLI, an optional local model) suggests only a category and a name. Code builds every destination, validates the whole plan, and binds your approval to a digest. Apply writes a journal record before and after every change. Recovery and undo look at the files again and refuse anything changed, missing or foreign. Exact duplicates go to a quarantine you can restore from. There is no delete.

Two surfaces share one TypeScript core (`src/core/`):

- **Hosted sandbox** (`src/ui/`, built with Vite): about forty synthetic files held in memory. Banner: "Sandbox — simulated file operations; no disk changes". Reload loses the sandbox. No account, key or backend.
- **Local CLI** (`cli/`): the only surface that may change real files, on your own machine, in one explicit unmanaged local folder. Native writes stay disabled until platform qualification passes.

## Full-mode validation in progress (2026-10-26)

Node 24.18.0 / npm 11.11.0. Dependencies are exact and frozen by `package-lock.json`; use `npm ci`. Vite 7.3.7, Vitest 4.1.12, React plugin 5.2.0. Node >=22.12.0 is required. Local changes are candidates awaiting independent reviewer acceptance.

| Surface/check | Actual result |
|---|---|
| Core/contracts/sandbox tests | 68 passed across 9 files, including UTF-8 bounds, explicit inclusion and fake model response contracts |
| Web + CLI typechecks | Passed; isolated core config also passed |
| Web build | Passed; static dist emitted |
| CLI build and built-bin help | Passed |
| Portable real-filesystem harness | 5 passed / 6 TODO; disposable test folders only; does not qualify native writes |
| Headless hosted journey | Author Chromium headless-shell built-bundle smoke passed: scan/propose/explicit selection/approve/apply and 33 sandbox traps; independent full journey pending |
| Windows helper | Real Win32 implementation plus optional adapter integration; default loader still disabled |
| Native release qualification | Incomplete: real facts/alias/junction/mutex/parent-loss probes and private ACL + guarded apply/undo passed after restart; full process-crash matrix and independent native gate pending |
| Optional local AI | Official Ollama chat-completions shape checked; injected fake transport tests pass; no real model called |
| Dependency audit | 0 advisories after patched toolchain install |

Default parallel worker startup failed during machine contention (no tests ran); the same suite passed with one worker. Historical failed browser and native startup attempts remain in the run records.

Construction probe receipts are in `cli/platform/QUALIFICATION-RESULTS.md` and `scripts/native-integration-RESULTS.md`. They are author-run diagnostics, not independent product acceptance. Native writes remain disabled until the combined implementation and actual NTFS crash/lifecycle/ACL checks pass independent review. Browser reload still discards sandbox state.

## Hosted journey

1. **Home / Scan**: scan the sandbox. Project folders (with `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod` or `*.sln`) are left whole; README/LICENSE/.env/lock files and hidden files are skipped.
2. **Propose**: Heuristic (extension rules, not AI) or Simulated AI example (a fixed response replayed from fixtures, with deliberately invalid items). No model is called.
3. **Review / Approve**: one row per file with original, exact destination, source, confidence and issues. Warnings start unselected. Blocked rows cannot be selected until you edit them. Approve the exact accepted diff and digest; any edit clears approval. Export or import plan JSON (imports are rebuilt and need fresh approval).
4. **Apply / Recovery**: apply the approved plan. Optionally arm an interruption at boundary N to stop mid-run, then recover. Interruption here demonstrates the recovery logic inside the page; it is not process-crash evidence.
5. **Runs / Undo**: journal viewer, undo preview, and an "external edit" simulation to see changed files refused.
6. **Duplicates / Restore**: exact SHA-256 groups, a highlighted keeper suggestion, nothing preselected; a separate reviewed quarantine plan; restore from a named quarantine run.
7. **Traps**: run the sandbox trap cases in the page. Native cases show "Not run".

## Local CLI

Build it locally (`npm run build:cli`) and run the built bin; there is no published npx package.

```text
node dist-cli/main.js qualify  "D:\Sorting\Inbox" --unmanaged
node dist-cli/main.js scan     "D:\Sorting\Inbox"
node dist-cli/main.js propose  "D:\Sorting\Inbox" --mode heuristic --out plan.json
node dist-cli/main.js validate "D:\Sorting\Inbox" --plan plan.json        # prints the fresh digest
node dist-cli/main.js apply    "D:\Sorting\Inbox" --plan plan.json --confirm <digest> --unmanaged
node dist-cli/main.js runs | report | recover | undo --preview | undo --yes
node dist-cli/main.js duplicates | quarantine --select <path> | restore --run <id> --entry <path>
```

- One explicit folder. Refused: UNC/network paths, drive roots, links/junctions in the ancestry, a real path that differs from the given path, and folders inside OneDrive or other recognizable cloud-sync roots. Detection of sync agents is heuristic, so `--unmanaged` must state that nothing syncs, backs up or indexes the folder.
- Qualification never writes a probe. Project folders and protected names are left alone exactly as in the sandbox.
- Private state lives in `%LOCALAPPDATA%\file-declutterer\<rootId>\` (plans, journals, LOCK), never inside the folder. The root id comes from the folder's volume and file identity; path hints never reassociate history on their own. A path that was registered under a different identity (recreated or remounted folder) blocks writes until resolved.
- **Native writes are currently refused.** The Win32 helper implementation exists in `cli/platform/windows-native.ts`, with optional integration into the adapter/state/lock. The default loader remains unavailable until independent native qualification passes. A source implementation or injected-helper test is insufficient to enable it.
- Local AI is optional: set `DECLUTTER_MODEL_URL` (loopback only) and `DECLUTTER_MODEL_NAME`. `--mode smart` sends only unknown-extension files; `--mode local` sends all eligible files. The CLI prints exactly what would be sent (opaque id, name, extension, parent folder name) and sends nothing without `--send-to-local-model`. Batches of at most 80 rows / 32 KiB, 64 KiB responses, 30 s per attempt, 7 attempts and 240 s per pass, no retries; failures leave those rows without AI proposals.

## Scripts

```text
npm ci               # install exact frozen dependency tree
npm run dev          # Vite dev server
npm run build        # web typecheck + vite build -> dist/
npm run build:cli    # tsc -p tsconfig.cli.json -> dist-cli/, plus dist-cli/main.js bin shim
npm run typecheck    # web + cli
npm test -- --maxWorkers=1 --no-file-parallelism # same suite, bounded workers for concurrent seats
npm run test:native  # explicit disposable-root native harness (tests/native)
```

Web build success says nothing about the CLI or native safety.

## Safety rules (summary)

- Proposals carry only `fileId`, `categoryId`, `basename`, `confidence`, `reason`. Unknown fields, ids or categories are rejected, never mapped. Encoded path syntax (`%2e%2e%2f`) is rejected without decoding; a literal source name such as `%41.txt` is kept as is.
- Destinations: `<root>/_Organized/<Category>/<basename><original extension>`; quarantine: `<root>/_declutter-quarantine/<runId>/<original path>`. Both are excluded from later ordinary scans.
- Blocked: duplicate or case/Unicode-equal destinations, occupied destinations, swaps, case-only renames, moves onto a path another row vacates, parent-is-file, prefix conflicts, protected names, path syntax and length violations, a basename carrying a known file-type suffix.
- Apply: flushed intent, exclusive hard link, identity and byte verification, guarded unlink, flushed outcome. No overwrite and no copy fallback. A failed unlink halts with both names pointing to one file.
- Reversal acts on what is on disk now, not on log labels. Foreign or changed files are preserved and reported. Folders are removed only when this run created them and they are empty.

## Prior art and license

MIT (see `LICENSE`). Ideas only, no code copied, from ai-file-sorter (AGPL), ZRename (GPL), File-Organizer-MCP, llm-file-organizer, filetx/fstx, fclones and sloth-sorter. The inactive legacy sources below were written for this project earlier.

## Inactive legacy source

`src/engine/`, `tests/*.test.ts`, `tests/pathFixtures.ts` and `supabase/` are an earlier cloud-database design kept for history. They are excluded from the web and CLI builds and from `npm test`, and must not be provisioned or deployed.
