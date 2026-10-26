---
extension: semantic-prompt-language
version: 1
model: 'gpt-6-luna'
---

```spl
let isFriday = ask(fmt='json') \
 'Is today Friday? Return true or false.'
if isFriday {
    success 'Today is Friday!'
} else {
    success ask 'Complain in original way'
}
```
