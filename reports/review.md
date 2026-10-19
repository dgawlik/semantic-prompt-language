# Review of repository

- **MEDIUM** Credential file permissions and symlink handling (lang\src\auth.ts:28-31)
  - Fix: Reject symlinked credential files, verify or enforce secure permissions on existing files and parent directories, and write credentials atomically. On Windows, use appropriate ACLs or a secure OS credential store.
- **HIGH** Filesystem restriction bypass for bare filenames (lang\src\tools.ts:140, 225-249)
  - Fix: Replace the heuristic with command-aware argument validation, or treat all non-option file operands, including bare relative filenames, as paths and validate them against the restriction. An OS-level sandbox would be more reliable.
- **HIGH** Network restriction bypass through web_search redirects (lang\src\tools.ts:207-216)
  - Fix: Use redirect: 'manual', validate every Location target with checkUrl(), and enforce a redirect limit as web_fetch does.
- **HIGH** Unbounded memory use before truncation (lang\src\tools.ts:169, 199, 216)
  - Fix: Read through bounded streams or readers and stop after the maximum byte budget, aborting the request or closing the file once the limit is reached.
- **MEDIUM** No execution budget for infinite loops (lang\src\interpreter.ts:154-166)
  - Fix: Add a configurable step or iteration budget and cancellation or deadline support, converting exhaustion into an explicit runtime failure.

5 finding(s), 3 high severity

aaa