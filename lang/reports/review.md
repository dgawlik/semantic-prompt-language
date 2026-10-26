# Review of repository

- **HIGH** Existing credentials files may remain readable by other users (src/auth.ts:30)
  - Fix: Ensure the credentials file is mode 0o600 even when it already exists, or write credentials to a securely created replacement file and atomically replace the existing file.

1 finding(s), 1 high severity