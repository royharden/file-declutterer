# Bolt handoff: File Declutterer

**Dirty Mode construction — runtime unverified.** Written 2026-10-23. Nothing in this repository has been installed, built, run or tested.

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

- Runtime: Node >= 20.11 (declared in `package.json` engines; not verified).
- Install: no lockfile yet. First authorized `npm install` generates `package-lock.json`; afterwards `npm ci`.
- Web build: `npm run build` -> `dist/` (typecheck + Vite). Never run.
- Dependencies (pinned ranges, unverified together): react ^18.3.1, react-dom ^18.3.1, vite ^5.4.0, @vitejs/plugin-react ^4.3.1, typescript ^5.5.4, vitest ^2.0.5, @types/node ^20.14.0.

## Status by surface

| Surface | Source | Runtime |
|---|---|---|
| Hosted sandbox | built in source | unverified |
| Local CLI | see outer STATUS.md | unverified |
| Native qualification | not built | native writes disabled |
| Bolt import / build | not attempted | pending |

## Acceptance checks (pending)

1. `npm ci && npm run build` succeeds in Bolt; the page opens with the sandbox banner.
2. Home / Scan -> Propose (Heuristic) -> Review -> Approve -> Apply commits; Runs shows the journal.
3. Arm an interruption, apply, then Recover restores the original tree.
4. Traps -> Run sandbox traps: every sandbox case passes; native cases show Not run.
5. No network requests other than the static assets.

## Prompt for a future Bolt run (inspection and preparation only)

> Import this repository root. It is a static React + Vite app with no backend: do not create a database, auth, storage, functions or secrets, and do not apply or deploy anything under `supabase/` (inactive legacy). Run `npm install` (or `npm ci` if a lockfile exists) and `npm run build`, open the preview, and walk the acceptance checks in BOLT-HANDOFF.md. Report concrete build or runtime gaps with file and line. Make code changes only for a concrete build or deployment gap. Publish nothing.
