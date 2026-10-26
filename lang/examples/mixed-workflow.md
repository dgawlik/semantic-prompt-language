---
extension: semantic-prompt-language
version: 1
preamble: Be precise and use the existing bindings.
---

# One workflow, two modes

Only the code and blockquotes below execute. This explanation is a comment.

```spl
let count = 20
def double(value) { return value * 2 }
```

> Set @count to @double of its current value, then add two.
> Keep going without terminating the document.

```spl
assert count == 42 'expected the natural-language step to update count'
```

> End the document successfully with @count using @success.
