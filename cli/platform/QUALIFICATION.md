# Windows helper qualification boundary

`windows-native.ts` / `windows-worker.ps1` / `windows-worker.cs` implement a real local PowerShell 7 + Win32 helper. No package download, account, API key, or network request is used. The worker uses stdin/stdout JSON RPC; user paths are arguments, never PowerShell or C# source. Mutex acquire/release execute synchronously on one OS thread. Parent process identity is monitored and EOF releases owned mutexes.

The default Windows loader supplies read-only native facts with `mutationQualified=false`, so attribute protection applies to actual CLI scans. Native mutations stay gated off until independent acceptance qualifies the combined adapter, lifecycle and journal. Other platforms retain the unavailable helper. Explicit construction probes may instantiate the internal helper for their own disposable roots; no CLI/environment switch opens this gate.

Facts: `GetVolumeInformationW`, `GetDriveTypeW`, `GetFileInformationByHandleEx(FileIdInfo)`, attributes including reparse/offline/recall, ancestry long-name expansion and case-sensitive-directory refusal, process start epoch and a named OS root mutex. Complete unknown/error facts refuse. Process access denied is not a dead-owner result. `flushDirectory` makes a real `FlushFileBuffers` call and throws when Windows refuses it; there is no silent directory-fsync substitute.

The emitted TypeScript can locate resources in this local source checkout. A separately packaged CLI must copy the two worker resources beside emitted JS. The source-resource fallback is only for the locally built CLI; Bolt does not run this helper.

Required integration outside this helper's ownership: qualified 128-bit identities must replace Node stat identities consistently in root IDs and all file observations; recheck helper component facts immediately before all native mutations; restrict private-state ACLs; wire real directory flush into state creation/replacement; qualify aliases against existing destinations; independently exercise child-process death, lock ownership, process-start mismatch, helper loss and every journal/FS boundary. Directory-flush support must be measured on the disposable target volume and a failure keeps native writes disabled.

Official API references consulted 2026-10-26:
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getlongpathnamew
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers
