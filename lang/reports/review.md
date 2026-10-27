# Review of repository

- **MEDIUM** Validate every search redirect against network restrictions (src/tools.ts — ToolHost.webSearch())
  - Fix: Disable automatic redirect following, inspect each redirect response, and run restrictions.checkUrl() on every redirect target before following it; enforce a maximum redirect count.
- **MEDIUM** Close filesystem path-check/open race (src/restrict.ts — Restrictions.checkPath(); src/tools.ts — readFile()/writeFile())
  - Fix: Avoid authorizing a canonicalized path and then opening it in a separate raceable step. Where supported, perform filesystem operations through handles opened without following links and verify the opened target and parent remain within the authorized root.
- **HIGH** Enforce restrictive permissions on existing credential files (src/auth.ts — saveToken())
  - Fix: After writing the credentials file, explicitly set its permissions to 0600 and ensure its parent directory is 0700. Alternatively, use safe exclusive creation and securely handle any existing file.

3 finding(s), 1 high severity