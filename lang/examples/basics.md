---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Basics

`js` fences run exact JavaScript. Blockquotes run agent commands with tools, not generated code.
Both share one scope; agents load and save variables and can invoke existing functions.

```js
function fib(n) {
    return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
```

```js
function factorial(n) {
    return n === 0 ? 1 : n * factorial(n - 1);
}
```

> Invoke @factorial with 15 as argument -> @fact15

> Invoke @fib with 10 as argument -> @fib10

> Add to @fib10 2 and save to @fibPlus2

> Ask the model for the 10th Fibonacci number as an integer, without using @fib. Save it to @modelFib10

```js
assert(fib10 === modelFib10, 'Oops, the model got it wrong');
```

> @joke = a joke about programmers as an object with "setup" and "punchline"

> @CTL(enforce='Answer in Chinese', forbid='Mentioning the word cat')
>
> Paragraph of funny story about a pet animal -> @animal

```js
success({ fib: fib10, modelFib: modelFib10, joke, animal });
```
