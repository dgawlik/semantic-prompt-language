---
title: Functions, Mutability & TCO
description: First-class functions, trailing lambdas, named parameters, mut self, arrays, dicts, and tail-call optimization.
---

## Functions & Trailing Lambdas

The last expression in a block is its return value (explicit `return` is also supported for early exits). When the final parameter is a function, you can write the lambda outside the parentheses:

```splx
fn apply_twice(x: Int, f: fn(Int) -> Int) -> Int {
    f(f(x))
}

let res = apply_twice(3) { n -> n * 2 } // 12

// Multi-parameter lambdas
let sum = [1, 2, 3, 4].fold(0) { acc, n -> acc + n } // 10
```

## Named Parameters & Default Values

Functions can declare default values and be called with named arguments in any order:

```splx
fn connect(host: Str = "localhost", port: Int = 8080, tls: Bool = false) -> Str {
    let scheme = if tls { "https" } else { "http" }
    "${scheme}://${host}:${port}"
}

let url = connect(port: 443, tls: true) // "https://localhost:443"
```

## Mutable Parameters (`mut self` & `mut param`)

Parameters are immutable by default. Mark a parameter `mut` to allow rebinding or in-place field mutation:

```splx
type Stack<T> = {
    elements: Array<T>
    length: Int
}

fn Stack<T>.push(mut self, item: T) {
    self.elements.push(item)
    self.length = self.length + 1
}

fn Stack<T>.pop(mut self) -> T? {
    if self.length == 0 {
        None
    } else {
        self.length = self.length - 1
        self.elements.pop()
    }
}

let mut s: Stack<Int> = { elements: [], length: 0 }
s.push(10)
s.push(20)
let top = s.pop() // Some(20)
```

Calling a `mut self` method or mutating `obj.field = val` on an immutable binding (`let s = ...` instead of `let mut s = ...`) is a compile-time error.

## Tuples, Arrays & Dicts

- **Tuples `(a, b)`**: Fixed-length, heterogeneous, destructurable (`let (name, age) = pair`).
- **Arrays `Array<T>` (`[1, 2, 3]`)**: Mutable dynamic arrays with `len`, `get`, `set`, `arr[i] = val`, `push`, `pop`, `swap`, `clear`, `slice`, `concat`, `map`, `par_map`, `filter`, `fold`, `flat_map`, `find`, `join`, and `iter`.
- **Dictionaries `Dict<K, V>`**: Copy-on-write immutable maps backed by JS `Map` (`dict_empty()`, `get`, `set`, `delete`, `entries`, `iter`, `keys_iter`, `values_iter`).

## Self-Tail-Call Optimization (TCO)

Because JavaScript engines do not guarantee tail-call optimization, the SPL compiler detects direct self-tail calls and lowers them into a `while (true)` loop — allowing deep recursion without stack overflow:

```splx
fn sum_to(n: Int, acc: Int = 0) -> Int {
    if n <= 0 {
        acc
    } else {
        sum_to(n - 1, acc + n) // Compiled to a flat JS `while` loop!
    }
}

print(sum_to(100_000)) // 5000050000 — zero stack growth
```
