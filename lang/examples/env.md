---
extension: semantic-prompt-language
version: 1
model: 'gpt-6-luna'
---

```spl
let lhs1 = $env.LHS
let rhs1 = $env.RHS

log(lhs1)
log(rhs1)

let lhs2 = $args[0]
let rhs2 = $args[1]

log(lhs2)
log(rhs2)

success ask(fmt='json') 'Sum of {lhs1} and {rhs1}'
```
