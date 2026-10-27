# Helper construction receipt — 2026-10-26

Author: `0767_Codex_GPT-61Sol_Sub_NativeHelper`, implementation child of S13-INT `0765`. This is construction evidence, not independent acceptance or a native trap score. The default `loadPlatformHelper()` is unchanged and still refuses native writes.

## Source ready for parent review

- `windows-native.ts`: typed JSON RPC client, shell-free PowerShell invocation, bounded requests, owned worker lifetime, root mutex liveness and optional fresh `assertHeld()` round trip.
- `windows-worker.ps1` / `windows-worker.cs`: PowerShell 7 hosts original C# Win32 interop. FileIdInfo returns volume identity plus full 128-bit file identity; ancestry inspection reports reparse/cloud attributes and refuses noncanonical long-name aliases or case-sensitive directories. Volume type, drive type, process-start epochs, an OS root mutex and real directory flush are implemented.
- `helper.ts`: optional `RootMutex.assertHeld()` capability added. The default loader remains unavailable; no native mutation is activated by these files.
- `scripts/helper-probe.mjs`: creates its own disposable root and synthetic files, probes facts/hard links/mutex/process identity/directory flush. Latest version additionally probes short aliases and a created junction.
- `scripts/helper-lifecycle-probe.mjs`: owns a child parent process, attempts mutex acquisition, kills only that owned parent and checks successor admission. Its owner-readiness stage has not completed successfully.

## Commands and observations

| Command / source state | Result |
|---|---|
| `node_modules/.bin/tsc.cmd -p tsconfig.cli.json --noEmit` before optional mutex assertion | PASS, exit 0 |
| Same typecheck after optional `assertHeld()` addition | PASS, exit 0 |
| First `node scripts/helper-probe.mjs` before short-alias/junction additions | PASS, exit 0; concrete observations below |
| First `node scripts/helper-lifecycle-probe.mjs` | FAIL, owner-readiness timeout at 60 s; no worker stderr; no lifecycle acceptance |
| Lifecycle probe rerun after replacing generated request delimiter with explicit character code | FAIL, same 60 s owner-readiness timeout; no worker stderr |
| `node scripts/helper-probe.mjs` after short-alias/junction additions | FAIL, helper RPC timeout at 60 s before evidence was emitted; no worker stderr; alias/junction changes remain unexecuted |

The passing basic probe created only `C:\Users\Roy Harden\AppData\Local\Temp\s13-helper-probe-o9EMpQ` and its synthetic contents. It observed a fixed local NTFS volume (remote=false, removable=false), full ancestry facts with no reparse/cloud flags, the same full file identity for two hard links, a process-start epoch for its live Node parent and null for an absent PID, refusal of a second worker's mutex acquisition followed by successful acquisition after release, and successful `FlushFileBuffers` on the created directory. Synthetic bytes remained intact. These observations apply to that exact construction probe, not every native case or the latest source additions.

The later timeout cause is unresolved. Other local shell commands were also unusually slow, which suggests contention but does not prove it caused the failures. No timeout was increased, no production safety gate was relaxed, and no failed/unknown result was converted to a pass. Parent instructed this child to stop heavy probes and preserve evidence.

## Required follow-up owned by parent / independent RV

1. Review and execute the current worker source, including the later short-name/junction additions. Diagnose startup versus RPC timeouts before tuning either.
2. Integrate helper identities consistently into qualification, root IDs, file observations and mutation preconditions. Node stat dev/ino must not be labeled qualified Win32 FileIdInfo merely because a helper exists.
3. Check native component facts and fresh mutex ownership before mutations, including existing ancestry below missing destination components. Add restricted private-state ACLs and wire real directory flushes into state/journal persistence.
4. Independently qualify native apply/reverse crash boundaries, process-start/PID mismatch, mutex/LOCK successor races, helper and parent loss, root recreation/rename, aliases/reparse/cross-volume and directory-flush failure behavior. Existing native harness forcing `writesEnabled` is not this gate.
5. Keep the default loader off until the combined implementation and actual native qualification pass independent review.

No commit made by this child; parent alone owns the shared Git index and source commits. No credential files read, remote APIs called, servers/containers started, publication performed, or pre-existing files deleted. Owned probe workers receive EOF when their probe closes; the worker also monitors its parent epoch and releases its mutex on exit.
