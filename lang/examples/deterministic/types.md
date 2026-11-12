---
extension: 'semantic-prompt-language'
version: 1
---

# Named types and annotations

```js
const Money = typedef('Money', int, { minimum: 0, desc: 'Amount in cents' });
const Prices = typedef('Prices', list(Money));
const MaybeMoney = nullable(Money);

const subtotal = Money.parse(1250);
const prices = Prices.parse([subtotal, subtotal * 2]);

function computeDiscount(total, discount) {
    const percent = MaybeMoney.parse(discount) ?? 10;
    return Math.trunc(Money.parse(total) * (100 - percent) / 100);
}

log(computeDiscount(1000, null));
log(Prices.schema());
success({ prices, discounted: computeDiscount(1000, 25) });
```
