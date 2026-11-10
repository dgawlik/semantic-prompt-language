# Code Review Report

Scope: `src/restrict.ts`, `src/typed-json.ts`, and `src/auth.ts`.

## Summary

- High: 1
- Medium: 0
- Low: 0

## High Severity

### Unbounded JSON nesting can crash parsing

**Location:** `src/typed-json.ts` — recursive `value()` in `parseWire`

**Recommended fix:** Track nesting depth and reject input beyond a documented limit with `Failure('invalid_format', ...)`; consider also bounding total input size to prevent oversized responses from exhausting resources.

## Medium Severity

No findings.

## Low Severity

No findings.
