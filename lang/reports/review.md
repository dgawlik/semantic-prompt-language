# Review of repository

- **HIGH** Existing credential files can retain overly broad permissions or redirect writes through symlinks (src/auth.ts — saveToken())
  - Fix: Write the token to a newly created exclusive temporary file with restrictive permissions, set and verify its mode, reject a symlink destination, then atomically replace the destination.
- **HIGH** Path validation is vulnerable to symlink-based TOCTOU escapes (src/restrict.ts — Restrictions.checkPath() / canonicalPath())
  - Fix: Bind validation to the filesystem operation using no-follow operations and directory handles where supported; otherwise revalidate at the operation boundary and reject symlinks.

2 finding(s), 2 high severity