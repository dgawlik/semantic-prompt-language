---
title: Records & Row Polymorphism
description: Structs, anonymous records, structural equivalence, functional spread, row polymorphism, and hybrid open records.
---

SPL uses **structural typing with row polymorphism**, combining JavaScript's lightweight object ergonomics with full static type checking and IDE completion.

## Named Structs & Anonymous Records

Named `struct` types are closed by default and compile directly to plain JS objects:

```splx
'' Customer profile.
type Person = struct {
    firstName: Str '' Given name
    age: Int       '' Age in years
}

// Anonymous record — structurally compatible with `Person`!
let ada = { firstName: "Ada", age: 36 }

fn is_adult(p: Person) -> Bool {
    p.age >= 18
}

print(is_adult(ada)) // true
```

## Functional Spread

Extend or update records immutably with `{ ...base, key: val }`:

```splx
let user = { firstName: "Ada", age: 36 }
let updated = { ...user, age: 37, role: "engineer" }
// inferred: { firstName: Str, age: Int, role: Str }
```

## Row Polymorphism (`..r`)

Write generic functions that require a subset of fields without losing the caller's extra fields:

```splx
// Accepts any record containing `firstName: Str`
fn greet(x: { firstName: Str, .. }) -> Str {
    "Hi " + x.firstName
}

// Inferred: fn({ ..r }) -> { ts: Int, ..r }
fn with_timestamp(x) {
    { ...x, ts: 1700000000 }
}

let tagged = with_timestamp({ firstName: "Ada", role: "admin" })
// `tagged.firstName`, `tagged.role`, and `tagged.ts` are all statically typed!
```

## Hybrid Open Records (`..extra: Dict<Str, V>`)

Model JSON payloads, HTTP headers, or tool events that mix statically known fields with arbitrary runtime keys:

```splx
type ToolEvent = struct {
    id: Str                   '' Unique event identifier
    kind: Str                 '' Event category
    ..extra: Dict<Str, Json>  '' Arbitrary extra runtime metadata
}
```

- **Dot access (`ev.id`)**: checked statically against known fields with full IDE completion.
- **Bracket indexing (`ev["trace_id"]`)**: accesses dynamic keys and returns `Option<V>` (`V?`) so missing keys are handled safely.
- **JSON Schema**: closed structs emit `"additionalProperties": false`, while hybrid open structs emit `"additionalProperties": <schema of V>`.
