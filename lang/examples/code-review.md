---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

> @CTL(restrict={fs: ['./src'], exec: ['git']}, forbid='suggesting purely stylistic changes')
>
> List source files with `git ls-files src`.
> Then read the 3 files that are most likely to contain security problems or correctness bugs, and review only those.
> List each finding with its location, why it matters and a suggested fix. Save to @notes


```spl
enum Severity = 'low' | 'medium' | 'high'

hydratable class Item:
    severity: Severity
    title: str
    location: str 
    fix: str 

hydratable class Review:
    findings: list[Item]
```

> Convert @notes into structured finding @validate[Review] save to @review

```spl

let groups = object() 
groups.high = []
groups.medium = []
groups.low = []

for f in review.findings:
    if f.severity == 'high':
        groups.high.append(f)
    elif f.severity == 'medium':
        groups.medium.append(f)
    else:
        groups.low.append(f)
```

> @CTL(restrict={fs: ['./reports']}, model='gpt-6.1-sol')
>
> Write convert @groups to markdown report 
> and write to './reports/review.md'

```spl
if len(groups.high) > 0:
    fail '{len(groups.high)} high severity finding(s), see ./reports/review.md'

success '\n'.join(lines)
```