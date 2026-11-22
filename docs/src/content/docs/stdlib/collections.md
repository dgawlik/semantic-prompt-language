---
title: Collections & Iterators (std/collections)
description: Lazy Iter<T> pipelines, HashMap<K, V>, self-balancing AVL TreeSet<T>, and immutable List<T>.
---

## Lazy Pull Iterators (`Iter<T>`)

`Iter<T>` provides zero-intermediate-allocation pull pipelines across `Array<T>`, `Dict<K, V>`, `Str.chars()`, `Str.bytes()`, ranges (`0..100..2`), custom `iter_from_fn`, and all `std/collections` types:

```splx
let top3 = (1..1_000_000)
    .filter { n -> n % 7 == 0 }
    .map { n -> n * n }
    .take(3)
    .collect()

// Custom lazy iterator
let mut i = 0
let counter = iter_from_fn { ->
    if i < 5 {
        let cur = i
        i = i + 1
        Some(cur)
    } else {
        None
    }
}
```

Available combinators: `next`, `map`, `filter`, `flat_map`, `take`, `skip`, `enumerate`, `zip`, `chain`, `collect`, `to_array`, `fold`, `for_each`, `find`, `any`, `all`, `count`.

## Pure SPL Immutable Collections (`std/collections`)

`std/collections` is implemented in pure SPL using structs, enums, and extension methods:

```splx
import col from "std/collections"

// 1. HashMap<K, V>
let scores = col.map_new()
    .put("alice", 95)
    .put("bob", 82)
    .map_values { v -> v + 5 }

print(scores.get_or("alice", 0)) // 100

// 2. Self-balancing AVL TreeSet<T> (O(log n) insert/remove/contains, sorted iteration)
let set_a = col.set_from_array([50, 20, 70, 10, 30])
let set_b = col.set_from_array([20, 30, 99])
let common = set_a.intersection(set_b).to_array() // [20, 30]

for x in set_a {
    print(x) // O(log n)-space lazy in-order traversal!
}

// 3. Immutable List<T>
let xs = col.list_from_array([10, 20, 30, 40])
let ys = xs.prepend(5).push(50).drop(1).take(3).reverse()
print(ys.to_array()) // [30, 20, 10]
```
