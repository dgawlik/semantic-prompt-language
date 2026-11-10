---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---


```spl 
let i = 0
while True:
    let msg = if not i % 2:
        '{i} is Even'
    elif i == 5:
        i += 1
        continue
    elif i == 11:
        break
    else:
        '{i} is Odd'
    log(level='debug')(msg)
    i += 1

let numbers = list(range(0,10,2))
for i, n in enumerate(numbers):
    log('{i} = {n}')
```