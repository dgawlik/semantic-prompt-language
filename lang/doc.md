# Fibonacci check

This a markdown comment. It is rendered as prose by `spl doc`.

Points:
* one
* two

> **file defaults**
>
> | Setting | Value |
> | --- | --- |
> | `model` | `gpt-6-luna` |

```ts
const Joke = Struct('Joke', { setup: Str, punchline: Str });

function fib(n: number): number {
    return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

function factorial(n: number): number {
    return n === 0 ? 1 : n * factorial(n - 1);
}
```

> **agent block**
>
> | Setting | Value |
> | --- | --- |
> | `reasoning` | `high` |
>
> Invoke @factorial with 15 as argument ->[Int] @fact15  
> Invoke @fib with 10 as argument ->[Int] @fib10  
> Add 2 to @fib10 ->[Int] @fibPlus2  
> Work out the 10th Fibonacci number yourself, without using @fib ->[Int] @modelFib10

```ts
assert(fib10 === modelFib10, 'Oops, the model got it wrong');
```

> **ask block**
>
> | Setting | Value |
> | --- | --- |
> | `outputVar` | `joke` |
> | `outputType` | `Joke` |
> | `enforce` | `Answer in Chinese` |
> | `forbid` | `Mentioning the word cat` |
>
> A joke about programmers with a setup and a punchline.

> **ask block**
>
> | Setting | Value |
> | --- | --- |
> | `outputVar` | `animal` |
>
> A paragraph of a funny story about a pet animal.

```ts
success({ fib: fib10, modelFib: modelFib10, joke, animal });
```
