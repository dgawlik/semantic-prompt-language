---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Extract an invoice into accounting-ready JSON

Turns a pasted or OCR'd invoice into structured data. The schema checks the shape;
ordinary arithmetic checks the numbers, because a model can produce valid JSON with wrong totals.

    spl examples/extract-invoice.md --arg ./examples/data/invoice.txt

```spl
let path = './examples/data/invoice.txt'
if $args[0] != None {
    path = $args[0]
}
let document = read_file(path)

let Money = {'type': 'number', 'minimum': 0}
let Invoice = {
    'type': 'object',
    'properties': {
        'vendor': {'type': 'string', 'minLength': 1},
        'number': {'type': 'string', 'minLength': 1},
        'date': {'type': 'string', 'pattern': '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$'},
        'currency': {'type': 'string', 'pattern': '^[A-Z]{{3}}$'},
        'lines': {
            'type': 'array', 'minItems': 1,
            'items': {
                'type': 'object',
                'properties': {
                    'description': {'type': 'string'},
                    'quantity': {'type': 'integer', 'minimum': 1},
                    'unit_price': Money,
                },
                'required': ['description', 'quantity', 'unit_price'],
                'additionalProperties': False,
            },
        },
        'subtotal': Money, 'tax': Money, 'total': Money,
    },
    'required': ['vendor', 'number', 'date', 'currency', 'lines', 'subtotal', 'tax', 'total'],
    'additionalProperties': False,
}
```

> @FORBID filling in values that are not printed on the invoice
>
> Extract the invoice in @document. Dates are ISO `YYYY-MM-DD`, currency is an ISO 4217 code,
> and there is one entry per line item. @validate[Invoice] save to @invoice

```spl
let computed = 0
for line in invoice.lines {
    computed += line.quantity * line.unit_price
}
assert abs(computed - invoice.subtotal) < 0.01 \
    "line items add up to {round(computed, 2)} but the subtotal is {invoice.subtotal}"
assert abs(invoice.subtotal + invoice.tax - invoice.total) < 0.01 \
    "subtotal {invoice.subtotal} + tax {invoice.tax} does not equal total {invoice.total}"

restrict './out/invoices' {
    write_file('./out/invoices/{invoice.number}.json', json_stringify(invoice, 2))
}
success invoice
```
