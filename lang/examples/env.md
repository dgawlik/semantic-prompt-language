---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

> Calculate the sum of @ENV.lhs and @ENV.rhs save to @sum

```spl
let lhs2 = $args[0]
let rhs2 = $args[1]

log(lhs2)
log(rhs2)
```

> Return @SUCCESS with @sum