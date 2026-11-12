---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Triage unlabeled GitHub issues

Classifies open issues without labels and applies the labels only after a human approves
the plan. Needs an authenticated `gh` CLI. Pass `--arg owner/repo` to target another repository.
Enums constrain labels and priorities; a named list alias lets the agent save the
whole batch with typed decoding. Field annotations are advice, so code checks nonempty reasons.

    spl examples/triage-issues.md --arg owner/repo

```js
const repo = args[0] ? `--repo ${args[0]}` : '';

const issues = await restrict({ exec: 'gh' }, async () => JSON.parse(
    await shell(`gh issue list ${repo} --state open --search "no:label" --limit 20 --json number,title,body`)));
if (issues.length === 0) success('No unlabeled issues');

const LABELS = ['bug', 'enhancement', 'question', 'documentation'];

const Plan = struct('Plan', {
    number: int,
    label: enumOf(...LABELS),
    priority: enumOf('low', 'medium', 'high'),
    reason: str.annotate({ minLength: 1 }),
});

const TriagePlan = typedef('TriagePlan', list(Plan));
```

> @CTL(forbid='judging an issue by its title alone when the body says otherwise')
>
> Classify every issue in @issues with exactly one label from @LABELS, a priority and a one-sentence reason.
> Crashes, data loss and security problems are high priority.
> @validate[TriagePlan] save to @plan

```js
const numbers = issues.map(issue => issue.number);
assert(plan.length === issues.length, `expected ${issues.length} decisions, got ${plan.length}`);

const table = plan.map(item => {
    assert(item.reason.trim().length > 0, `issue #${item.number} needs a reason`);
    assert(numbers.includes(item.number), `issue #${item.number} is not part of this batch`);
    assert(plan.filter(other => other.number === item.number).length === 1, `issue #${item.number} was classified twice`);
    return `#${item.number} -> ${item.label} (${item.priority}): ${item.reason}`;
});
```

> Show the @table lines and ask the human "Apply these labels? (yes/no)". Save the answer to @approved

```js
if (!approved.trim().toLowerCase().startsWith('y')) fail('Labels were not applied');

await restrict({ exec: 'gh' }, async () => {
    for (const item of plan) await shell(`gh issue edit ${item.number} ${repo} --add-label ${item.label}`);
});
success(table);
```
