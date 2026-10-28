---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

> @FORBID suggesting purely stylistic changes
>
> @RESTRICT fs['./src'] exec['git']
>
> List source files with `git ls-files src`.
> Then read the 3 files that are most likely to contain security problems or correctness bugs, and review only those.
> List each finding with its location, why it matters and a suggested fix. Save to @notes


```spl
let Review = {
    'type': 'object',
    'properties': {
        'findings': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {
                    'severity': {'type': 'string', 'enum': ['low', 'medium', 'high']},
                    'title': {'type': 'string'}, 'location': {'type': 'string'}, 'fix': {'type': 'string'},
                },
                'required': ['severity', 'title', 'location', 'fix'],
                'additionalProperties': False,
            },
        },
    },
    'required': ['findings'],
    'additionalProperties': False,
}
```

> Convert @notes review into structured finding @validate[Review] save to @review

```spl
let lines = ["# Review of repository", '']
let high = 0
for f in review.findings:
    assert f.severity in ['low', 'medium', 'high'] \
    "bad severity '{f.severity}'"
    if f.severity == 'high':
        high += 1
    lines.append("- **{f.severity.upper()}** {f.title} ({f.location})")
    lines.append("  - Fix: {f.fix}")
lines.append('')
lines.append("{len(review.findings)} finding(s), {high} high severity")
```

> @RESTRICT fs['./reports']
>
> Write joined @lines to './reports/review.md'

```spl
if high > 0:
    fail '{high} high severity finding(s), see ./reports/review.md'
success '\n'.join(lines)
```