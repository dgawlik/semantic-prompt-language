# Examples

Every example is a runnable document in [lang/examples](../lang/examples/). Run them from the `lang`
folder, for example `spl examples/hi.md`: relative paths and imports resolve against the working
directory. Each example's header shows its arguments.

## Getting started

| Example | Shows |
| --- | --- |
| [hi.md](../lang/examples/hi.md) | A struct schema with one repair, a blockquote saving a shared variable, the Markdown builder |
| [basics.md](../lang/examples/basics.md) | Agents calling JavaScript functions, checking a model's answer against exact code, `@CTL(enforce=..., forbid=...)` |
| [is-friday.md](../lang/examples/is-friday.md) | Branching on a boolean answer |
| [env.md](../lang/examples/env.md) | Reading `env` and `args` in code, `@env.NAME` in a blockquote |
| [color-poem.md](../lang/examples/color-poem.md) | Asking a person in plain language, or supplying `--human blue --human apple` |

## No model required

These run offline, without credentials.

| Example | Shows |
| --- | --- |
| [typed-data.md](../lang/examples/typed-data.md) | Enums, aliases, exact structs, nullable fields, unions, classes with methods, validation and JSON Schema output |
| [markdown.md](../lang/examples/markdown.md) | The Markdown builder |
| [deterministic/node.md](../lang/examples/deterministic/node.md) | Plain JavaScript with Node.js built-ins and top-level `await` |
| [deterministic/enumsStructs.md](../lang/examples/deterministic/enumsStructs.md) | `parse` and `is` on enums and structs |
| [deterministic/types.md](../lang/examples/deterministic/types.md) | Named types, annotations and their JSON Schema |
| [imports/run.md](../lang/examples/imports/run.md) | Importing a local `.js` module and `node:os` |

## Developer workflows

| Example | Shows |
| --- | --- |
| [code-review.md](../lang/examples/code-review.md) | A restricted review agent, typed findings and a run that fails CI on high-severity findings |
| [code-review.spl](../lang/examples/code-review.spl) | The same review as a [`.spl` file](Language.md#dedicated-spl-files): blocks instead of fences and blockquotes |
| [release-notes.md](../lang/examples/release-notes.md) | User-facing notes from `git log` prepended to `CHANGELOG.md` |
| [triage-issues.md](../lang/examples/triage-issues.md) | Enums and a named list type; labeling GitHub issues with `gh` after human approval |
| [codegen.md](../lang/examples/codegen.md) | Generating functions with `@CODEGEN` and `codegen()`, cached with `--trace` |
| [repo.md](../lang/examples/repo.md) | An agent auditing the repository, with plain code deciding the outcome |

## Data and documents

| Example | Shows |
| --- | --- |
| [extract-invoice.md](../lang/examples/extract-invoice.md) | Struct schemas and a `Money` alias with integer-cent arithmetic |
| [types.md](../lang/examples/types.md) | Unions and a class type as model output |
| [translate-docs.md](../lang/examples/translate-docs.md) | Translations verified to keep links, code and headings |
| [incident-report.md](../lang/examples/incident-report.md) | Exact log statistics, model-written narrative |
| [web-digest.md](../lang/examples/web-digest.md) | Web research with restricted fetches and checked citations |
| [randomness.md](../lang/examples/randomness.md) | Sampling options on `ask` |

## Agents, state and people

| Example | Shows |
| --- | --- |
| [mcp.md](../lang/examples/mcp.md) | An agent limited to one MCP tool |
| [journal.md](../lang/examples/journal.md) | Explicit JSON journal state with resumable trace runs |
| [human-review.md](../lang/examples/human-review.md) | Asking for review directly, with optional trace resumption |

## Extract an invoice

The struct schema checks the shape of the answer; a reusable `Money` alias documents that amounts
are integer cents. Annotations such as `minimum: 0` are advice for the model, not constraints;
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

```js
const path = args[0] ?? './examples/data/invoice.txt';
const text = await readFile(path);

const Money = typedef('Money', int, { minimum: 0, desc: 'Monetary amount in cents' });

const LineItem = struct('LineItem', {
    description: str,
    quantity: int.annotate({ minimum: 1 }),
    unit_price: Money,
});

const Invoice = struct('Invoice', {
    vendor: str.annotate({ minLength: 1 }),
    number: str.annotate({ minLength: 1 }),
    date: str.annotate({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' }),
    currency: str.annotate({ pattern: '^[A-Z]{3}$' }),
    lines: list(LineItem),
    subtotal: Money,
    tax: Money,
    total: Money,
});
```

> @CTL(forbid='filling in values that are not printed on the invoice')
>
> Extract the invoice in @text. Dates are ISO `YYYY-MM-DD`, currency is an ISO 4217 code,
> and there is one entry per line item. Convert printed monetary amounts to integer cents
> (for example, 12.50 becomes 1250). @validate[Invoice] save to @invoice

```js
const computed = invoice.lines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0);

assert(computed === invoice.subtotal,
    `line items add up to ${computed} cents but the subtotal is ${invoice.subtotal} cents`);
assert(invoice.subtotal + invoice.tax === invoice.total,
    `subtotal ${invoice.subtotal} + tax ${invoice.tax} does not equal total ${invoice.total} cents`);

await restrict('./out/invoices', () =>
    writeFile(`./out/invoices/${invoice.number}.json`, JSON.stringify(invoice, null, 2)));
success(invoice);
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
````

## Plain JavaScript

No model is involved here: the workflow imports Node.js built-ins, declares a function and ends
with a JSON result.

`deterministic/node.md`

````markdown
---
extension: 'semantic-prompt-language'
version: 1
---

# Plain JavaScript and the Node.js standard library

Fences are native JavaScript: top-level `await`, imports and every Node.js built-in work as usual.

```js
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

function fib(n) {
    return n < 2 ? 1 : fib(n - 1) + fib(n - 2);
}

const evens = Array.from({ length: 5 }, (_, index) => index * 2);
for (const [index, n] of evens.entries()) log(`${index} = ${n}`);

await sleep(10);
const digest = createHash('sha256').update(String(fib(10))).digest('hex').slice(0, 8);
success({ fib: fib(10), evens, digest, file: path.basename(import.meta.filename) });
```
````
