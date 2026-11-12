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
