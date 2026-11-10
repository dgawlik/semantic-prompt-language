---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---


```spl 
def fib(n):
    return if n < 2:
        1
    else:
        fib(n-1) + fib(n-2)

log(fib(10))

def iterate(from, to, f):
    for n in range(from, to):
        log(f(n))

iterate(9,10,fib)

iterate(1, 10, lambda x: x*2 + 3)
```