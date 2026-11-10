---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---


```spl 
enum Greeting = 'hello' | 'world'

# let g: Greeting = 'hi' // error
let g: Greeting = 'hello'
log(g)

struct Test:
    num: int 
    desc: str 

let t: Test = object:
    'num': 1
    'desc': 'hi'

log(t)

let o1 = object:
    'a': 1
    'b': [2,3]
let o2 = object:
    'a': 1
    'b': [2,3]

assert o1 == o2
   
```