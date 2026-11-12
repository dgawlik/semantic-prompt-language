---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Review the riskiest source files

An agent picks and reviews three files inside `./src`, a second step turns its notes into typed
findings, and plain code decides whether the run fails.

> @CTL(restrict={fs: ['./src'], exec: ['git']}, forbid='suggesting purely stylistic changes')
>
> List source files with `git ls-files src`.
> Then read the 3 files that are most likely to contain security problems or correctness bugs, and review only those.
> List each finding with its location, why it matters and a suggested fix. Save to @notes

```js
const Severity = enumOf('low', 'medium', 'high');

const Item = struct('Item', {
    severity: Severity,
    title: str,
    location: str.annotate({ desc: 'File path and line' }),
    fix: str,
});

const Review = struct('Review', { findings: list(Item) });
```

> Convert @notes into structured finding @validate[Review] save to @review

```js
const groups = Object.groupBy(review.findings, finding => finding.severity);
const high = groups.high ?? [];
```

> @CTL(restrict={fs: ['./reports']}, model='gpt-6.1-sol')
>
> Convert @groups to a Markdown report and write it to './reports/review.md'

```js
if (high.length > 0) fail(`${high.length} high severity finding(s), see ./reports/review.md`);

success(review.findings.map(finding => `${finding.severity}: ${finding.title} (${finding.location})`).join('\n'));
```
