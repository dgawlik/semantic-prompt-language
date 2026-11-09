# Examples

Every example is a runnable document in [lang/examples](../lang/examples/). Run them from the `lang`
folder, for example `spl examples/hi.md`. Each example's header shows its arguments.

## Getting started

| Example | Shows |
| --- | --- |
| [hi.md](../lang/examples/hi.md) | Hydrated class schemas, shared variables, an assertion and a restricted JSON projection |
| [basics.md](../lang/examples/basics.md) | Checking a model's answer against exact code; guidance with `@ENFORCE` and `@FORBID` |
| [is-friday.md](../lang/examples/is-friday.md) | Branching on a JSON answer |
| [env.md](../lang/examples/env.md) | Reading `$env` and `--arg` values |
| [color-poem.md](../lang/examples/color-poem.md) | Asking a person directly with `@HUMAN`, or supplying `--human blue --human apple` |

## Developer workflows

| Example | Shows |
| --- | --- |
| [code-review.md](../lang/examples/code-review.md) | A review that fails CI on high-severity findings |
| [release-notes.md](../lang/examples/release-notes.md) | User-facing notes from `git log` prepended to `CHANGELOG.md` |
| [triage-issues.md](../lang/examples/triage-issues.md) | Enums and a named typed-list schema; labeling GitHub issues with `gh` after human approval |

## Data and documents

| Example | Shows |
| --- | --- |
| [extract-invoice.md](../lang/examples/extract-invoice.md) | Struct schemas and a `Money` alias with integer-cent arithmetic |
| [typed-data.md](../lang/examples/typed-data.md) | Primitives, aliases, unions, validation, guarded lists, structs, classes, callable fields and deep projection without a model |
| [translate-docs.md](../lang/examples/translate-docs.md) | Translations verified to keep links, code and headings |
| [incident-report.md](../lang/examples/incident-report.md) | Exact log statistics, model-written narrative |
| [web-digest.md](../lang/examples/web-digest.md) | Web research with restricted fetches and checked citations |

## Agents, state and people

| Example | Shows |
| --- | --- |
| [mcp.md](../lang/examples/mcp.md) | An agent limited to one MCP tool |
| [journal.md](../lang/examples/journal.md) | Explicit JSON journal state with resumable trace runs |
| [human-review.md](../lang/examples/human-review.md) | Asking for review directly, with optional append-only trace resumption |

## Extract an invoice

The struct schema checks the shape of the answer; a reusable `Money` alias keeps arithmetic
in signed-64-bit integer cents. Metadata such as `minimum=0` is model advice, not a constraint;
plain arithmetic checks that the numbers add up.

`extract-invoice.md`

````markdown
---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Extract an invoice into accounting-ready JSON

Turns a pasted or OCR'd invoice into structured data. Monetary amounts use integer cents.
The schema checks the shape; exact arithmetic checks the numbers, because a model can
produce valid JSON with wrong totals.

    spl examples/extract-invoice.md --arg ./examples/data/invoice.txt

```spl
let path = './examples/data/invoice.txt'
if $args[0] != None:
    path = $args[0]
let document = read_file(path)

type Money = int [minimum=0, desc='Monetary amount in cents']

struct LineItem:
    description: str
    quantity: int [minimum = 1]
    unit_price: Money

struct Invoice:
    vendor: str [minLength = 1]
    number: str [minLength = 1]
    date: str [pattern = '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$']
    currency: str [pattern = '^[A-Z]{{3}}$']
    lines: list[LineItem]
    subtotal: Money
    tax: Money
    total: Money
```

> @FORBID filling in values that are not printed on the invoice
>
> Extract the invoice in @document. Dates are ISO `YYYY-MM-DD`, currency is an ISO 4217 code,
> and there is one entry per line item. Convert printed monetary amounts to integer cents
> (for example, 12.50 becomes 1250). @validate[Invoice] save to @invoice

```spl
if isinstance(invoice, Invoice):
    let computed: Money = 0

    for line in invoice.lines:
        computed += line.quantity * line.unit_price

    assert computed == invoice.subtotal \
    "line items add up to {computed} cents but the subtotal is {invoice.subtotal} cents"

    assert invoice.subtotal + invoice.tax == invoice.total \
    "subtotal {invoice.subtotal} + tax {invoice.tax} does not equal total {invoice.total} cents"

    restrict './out/invoices':
        write_file('./out/invoices/{invoice.number}.json', json_stringify(invoice, 2))
    success invoice
```
````

## Triage issues

Exact `gh` calls fetch and label issues; the model only classifies, and nothing changes until a person approves.

`triage-issues.md`

````markdown
---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Triage unlabeled GitHub issues

Classifies open issues without labels and applies the labels only after a human approves
the plan. Needs an authenticated `gh` CLI. Pass `--arg owner/repo` to target another repository.
Enums constrain labels and priorities; a named list alias lets the agent save the
whole batch with typed decoding. Field metadata is advice, so code checks nonempty reasons.

    spl examples/triage-issues.md --arg owner/repo

```spl
let repo = ''
if $args[0] != None:
    repo = "--repo {$args[0]}"
let issues = []
restrict exec 'gh':
    issues = json_parse(shell('gh issue list {repo} --state open --search "no:label" --limit 20 --json number,title,body'))
if len(issues) == 0:
    success 'No unlabeled issues'
let LABELS = ['bug', 'enhancement', 'question', 'documentation']

enum Labels = 'bug' | 'enhancement' | 'question' | 'documentation'

enum Priority = 'low' | 'medium' | 'high'

hydratable class Plan:
    number: int
    label: Labels
    priority: Priority
    reason: str [minLength = 1]

type TriagePlan = list[Plan]
```

> @FORBID judging an issue by its title alone when the body says otherwise
>
> Classify every issue in @issues with exactly one label from @LABELS, a priority and a one-sentence reason.
> Crashes, data loss and security problems are high priority.
> @validate[TriagePlan] save to @plan

```spl
let numbers = []
for issue in issues:
    numbers.append(issue.number)
let planned = []
for p in plan:
    planned.append(p.number)
assert len(plan) == len(issues) "expected {len(issues)} decisions, got {len(plan)}"
let table = []
for p in plan:
    assert len(p.reason.strip()) > 0 "issue #{p.number} needs a reason"
    assert p.number in numbers "issue #{p.number} is not part of this batch"
    assert planned.count(p.number) == 1 "issue #{p.number} was classified twice"
    table.append("#{p.number} -> {p.label} ({p.priority}): {p.reason}")
```

> @HUMAN Show the @table lines and ask "Apply these labels? (yes/no)". Save the answer to @approved

```spl
if not approved.strip().lower().startswith('y'):
    fail 'Labels were not applied'
restrict exec 'gh':
    for p in plan:
        shell('gh issue edit {p.number} {repo} --add-label {p.label}')
success table
```
````
