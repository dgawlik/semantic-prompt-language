---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Triage unlabeled GitHub issues

Classifies open issues without labels and applies the labels only after a human approves
the plan. Needs an authenticated `gh` CLI. Pass `--arg owner/repo` to target another repository.

    spl examples/triage-issues.md --checkpoint triage.jsonl --arg owner/repo

```spl
let repo = ''
if $args[0] != None {
    repo = "--repo {$args[0]}"
}

let issues = []
restrict exec 'gh' {
    issues = json_parse(shell('gh issue list {repo} --state open --search "no:label" --limit 20 --json number,title,body'))
}
if len(issues) == 0 {
    success 'No unlabeled issues'
}

let LABELS = ['bug', 'enhancement', 'question', 'documentation']
let Plan = {
    'type': 'array',
    'items': {
        'type': 'object',
        'properties': {
            'number': {'type': 'integer'},
            'label': {'type': 'string', 'enum': LABELS},
            'priority': {'type': 'string', 'enum': ['low', 'medium', 'high']},
            'reason': {'type': 'string', 'minLength': 1},
        },
        'required': ['number', 'label', 'priority', 'reason'],
        'additionalProperties': False,
    },
}
```

> @FORBID judging an issue by its title alone when the body says otherwise
>
> Classify every issue in @issues with exactly one label from @LABELS, a priority and a one-sentence reason.
> Crashes, data loss and security problems are high priority.
> @validate[Plan] @retries[2] save to @plan

```spl
let numbers = []
for issue in issues {
    numbers.append(issue.number)
}
let planned = []
for p in plan {
    planned.append(p.number)
}
assert len(plan) == len(issues) "expected {len(issues)} decisions, got {len(plan)}"

let table = []
for p in plan {
    assert p.number in numbers "issue #{p.number} is not part of this batch"
    assert planned.count(p.number) == 1 "issue #{p.number} was classified twice"
    table.append("#{p.number} -> {p.label} ({p.priority}): {p.reason}")
}
```

> @HUMAN Show the @table lines and ask "Apply these labels? (yes/no)". Save the answer to @approved

```spl
if not approved.strip().lower().startswith('y') {
    fail 'Labels were not applied'
}
restrict exec 'gh' {
    for p in plan {
        shell('gh issue edit {p.number} {repo} --add-label {p.label}')
    }
}
success table
```
