---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Basics

SPL fences run exact code. Blockquotes run agent commands with tools, not generated SPL.
Both share one scope; agents load and save variables and can invoke existing functions.

```spl
def fib(n) {
    if n < 2 {
        return n
    }
    return fib(n - 1) + fib(n - 2)
}
```

```spl
def factorial(n){
    if n == 0 {
        return 1
    } else {
        return n * factorial(n - 1)
    }
}
```

> Invoke @factorial with 15 as argument -> @fact15

> Invoke @fib with 10 as argument -> @fib10

> Add to @fib10 2 and save to @fibPlus2



> Ask the model for the 10th Fibonacci number as an integer, without using @fib. Save it to @modelFib10

```spl
assert fib10 == modelFib10 'Oops, the model got it wrong'
```

> @joke = a joke about programmers as an object with "setup" and "punchline"

> @ENFORCE Answer in Chinese
>
> @FORBID Mentioning the word cat
>
> Paragraph of funny story about a pet animal -> @animal

```spl
success {'fib': fib10, 'modelFib': modelFib10, 'joke': joke, 'animal': animal}
```