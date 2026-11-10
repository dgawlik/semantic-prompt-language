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

> @CTL(forbid='filling in values that are not printed on the invoice')
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
