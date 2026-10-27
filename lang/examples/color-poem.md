---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

> @HUMAN What is your favorite color? Save to @color

> @HUMAN What is your favorite fruit? Save to @fruit

> A paragraph long poem about @color and @fruit -> @poem

```spl
success {'poem': poem}
```

