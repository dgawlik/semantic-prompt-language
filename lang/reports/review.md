# Review Report

## High

### Redirects can bypass network host restrictions

- **Location:** `src/restrict.ts`, `Restrictions.checkUrl()`
- **Finding:** Network restrictions validate only the URL’s initial hostname. A redirect-following HTTP client may follow a redirect from an allowed host to an unallowed host, bypassing the restriction.
- **Fix:** Validate the hostname on every redirect, or disable automatic redirects and validate each `Location` header before following it.

## Medium

_No findings._

## Low

_No findings._
