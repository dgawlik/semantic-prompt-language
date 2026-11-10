---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---


```spl 
let a = 10
let b: int = int(a)
let c: float = float(b)


type Money = int [minimum=0, desc='Amount in cents']
type Prices = list[Money]
type MaybeMoney = Money | None
let subtotal: Money = 1250
let computed: Money = 0
computed += subtotal
let prices: Prices = [subtotal, computed]
let discount: MaybeMoney = None

def computeDiscount(total: Money, 
                    discount: MaybeMoney) -> Money:
    let discountWithDefault = if isinstance(discount, None):
        int(10)
    else:
        validate(discount, Money)
    return int(total * (100-discountWithDefault) / 100)


log(computeDiscount(1000, None))

```