---
title: Traits, Extensions & Modules
description: 1-file-per-module imports/exports, lightweight traits, structural coherence, and extension methods.
---

## Modules (`pub` & `import`)

Every `.splx` file is one ES Module. Declarations are private by default and exported with `pub`:

```splx
// lib/math.splx
pub fn square(n: Int) -> Int {
    n * n
}
```

Import by namespace, named destructuring, alias, or both:

```splx
import fs from "std/fs"
import { square as sq } from "./lib/math.splx"
import llm, { Approve, Reject } from "std/llm"
```

## Extension Methods

Attach methods to any type — including structural open record shapes — scoped by module `import`:

```splx
// Works on any record that has `firstName: Str` and `lastName: Str`
pub fn { firstName: Str, lastName: Str, .. }.full_name(self) -> Str {
    self.firstName + " " + self.lastName
}

// Mutating extension method on a generic type
pub fn Stack<T>.push(mut self, item: T) {
    self.elements.push(item)
    self.length = self.length + 1
}
```

## Traits & Structural Coherence

Declare traits with `trait` and implement them with `impl`:

```splx
trait Describable {
    fn describe(self) -> Str
}

type Point = struct { x: Int, y: Int }

impl Describable for Point {
    fn describe(self) -> Str {
        "(${self.x}, ${self.y})"
    }
}

fn log_item<T: Describable>(item: T) {
    print(item.describe())
}
```

### Coherence Under Structural Equivalence

Because SPL records are structurally typed, two `impl` blocks for the same trait on structurally identical record shapes in the same scope are rejected at compile time. When you need distinct trait behavior for the same underlying shape, wrap it in a nominal single-variant `enum` (**newtype**):

```splx
enum Celsius { Celsius(Float) }
enum Fahrenheit { Fahrenheit(Float) }
```
