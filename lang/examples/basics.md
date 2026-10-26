---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Basics

SPL fences run exact code. Blockquotes are natural-language steps. Both share one scope.

```spl
def fib(n) {
    if n < 2 {
        return n
    }
    return fib(n - 1) + fib(n - 2)
}
```

> Ask the model for the 10th Fibonacci number as an integer, without using @fib. Save it to @modelFib10

```spl
assert fib(10) == modelFib10 'Oops, the model got it wrong'
```

> @joke = a joke about programmers as an object with "setup" and "punchline"

> @ENFORCE Answer in Chinese
>
> @FORBID Mentioning the word cat
>
> Paragraph of funny story about a pet animal -> @animal

```spl
success {'fib': fib(10), 'modelFib': modelFib10, 'joke': joke, 'animal': animal}
```