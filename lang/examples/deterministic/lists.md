---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---


```spl
let lst = [1,2,3,4];

let secondElement = lst[1];
let thirdIndex = lst.index(3);
log('Second element: {secondElement}');
log('Threes index: {thirdIndex}')

let l2 = [5,6];
let combined = lst + l2
log('Extend list {combined}')


let removedSecond = combined.copy()
removedSecond.pop(1)
log('Removed second: {removedSecond}')

let removedLast = combined.copy()
removedLast.pop(-1)
log('Removed last: {removedLast}')

let remove3 = combined.copy()
remove3.remove(3)
log('Removed 3: {remove3}')

try:
    let remove7 = combined.copy()
    remove7.remove(7)
except e:
    log(e.reason)

let ins = [1,10]
ins.insert(1, 100)
log('Inserted: {ins}')

ins.clear()
log('Cleared: {ins}')

```