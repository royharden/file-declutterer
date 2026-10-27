# Bolt handoff: File Declutterer

**FULL-mode local validation in progress — 2026-10-26.** Web/CLI builds, typechecks and 68 core/contract/sandbox tests passed locally. Independent acceptance and hosted full browser journey are pending; native writes remain disabled. No Bolt import/publication was performed.

## Target

- Import root: this folder (the inner `file-declutterer` Git repository). The outer planning folder is not part of the app.
- Database path: **No database.** The hosted app is a static in-memory sandbox.
- Branch/revision: local `main` only; no remote exists. Publication is a separate owner decision.

## Inventory

| Resource | Status |
|---|---|
| Database / migrations | Not required |
| Auth | Not required |
| Storage buckets | Not required |
| Realtime | Not required |
| Edge functions | Not required |
| Server secrets | Not required |
| Public env vars | Not required |
| Scheduled jobs / workers | Not required |

`supabase/` holds an inactive legacy migration and function from an earlier design. **Do not apply, deploy or auto-provision it.** It is excluded from the web build.

The local CLI (`cli/`) and any Windows qualification helper run on the user's own machine. Bolt supplies neither native file moves nor a local model. CLI-only local config names (no values, never `VITE_`): `DECLUTTER_MODEL_URL`, `DECLUTTER_MODEL_NAME`.

## Build

- Runtime: Node >=22.12.0; locally exercised on Node 24.18.0 / npm 11.11.0.
- Install: `npm ci` uses the committed lockfile and exact direct versions.
- Web build: `npm run build` -> `dist/` (typecheck + Vite). Passed locally.
- The web bundle must not include `cli/`, `src/engine/` or `supabase/`; `tests/contract/web-graph.test.ts` checks the source import graph (passed locally).
- Exact direct dependencies and transitive lock are in package.json/package-lock.json; Vite 7.3.7, Vitest 4.1.12 and plugin-react 5.2.0 replace the vulnerable initial tooling.

## Status by surface

| Surface | Source | Runtime |
|---|---|---|
| Hosted sandbox | builds locally | author smoke passed; independent full journey pending |
| Local CLI (`cli/`, user machine only) | build/bin help passed | portable harness 5 pass/6 TODO; native writes refused |
| Native qualification helper | Win32 implementation + optional integration | real facts/alias/junction/mutex/parent-loss/ACL/apply/undo author probes pass; full native crash and independent gate incomplete |
| Bolt import / build | not attempted | pending |

## Acceptance checks (pending)

1. `npm ci && npm run build` succeeds in Bolt; the page opens with the sandbox banner.
2. Home / Scan -> Propose (Heuristic) -> Review -> Approve -> Apply commits; Runs shows the journal.
3. Arm an interruption, apply, then Recover restores the original tree.
4. Traps -> Run sandbox traps: every sandbox case passes; native cases show Not run.
5. No network requests other than the static assets.

## Prompt for a future Bolt run (inspection and preparation only)

> Import this repository root. It is a static React + Vite app with no backend: do not create a database, auth, storage, functions or secrets, and do not apply or deploy anything under `supabase/` (inactive legacy). Run `npm install` (or `npm ci` if a lockfile exists) and `npm run build`, open the preview, and walk the acceptance checks in BOLT-HANDOFF.md. Report concrete build or runtime gaps with file and line. Make code changes only for a concrete build or deployment gap. Publish nothing.
