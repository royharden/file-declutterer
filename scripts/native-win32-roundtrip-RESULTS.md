# Real Win32 roundtrip construction receipt

Author INT0765, candidate76c1eb2 plus new probe script,2026-10-26 after recovery. Not independent acceptance.

`node scripts/native-win32-roundtrip.mjs`: PASS. Created only own temporary unmanaged inbox and separate private state. Real WindowsPlatformHelper qualification, Win32 file IDs, private state ACL creation/validation, OS root mutex/strict LOCK, real journal+metadata flush, one exclusive hardlink move and latest-run undo succeeded. Independent Node SHA-256 path manifest after undo matched the original. Counts apply1/reverse1/unresolved0. Sandbox preserved at C:\Users\Roy Harden\AppData\Local\Temp\s13-win32-roundtrip-tCW0WN.

`node scripts/helper-probe.mjs`: first current-source run failed existing8.3 rejection assertion. .NET expanded alias before validation. Fixed in76c1eb2 by checking supplied spelling before GetFullPath. Rerun PASS: existing8.3 refused, actual junction reparse observed, NTFS fixed-local facts, full128-bit hardlink identity, process epoch vs absentPID, two-worker mutex exclusion/release and actual directory FlushFileBuffers.

`node scripts/helper-lifecycle-probe.mjs`: PASS after restart; killed its own parent child only; successor acquired same OS mutex. The earlier60s startup timeouts remain historical failures, not erased.

Native loader stays disabled. Full process-crash boundary matrix, lost helper/LOCK/PID/root changes, cross-volume and independent M6 qualification remain pending. A native roundtrip does not satisfy that full gate. No model/network calls, credentials, user folders or Docker used.
