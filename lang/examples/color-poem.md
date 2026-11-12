---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

> Ask the human "What is your favorite color?" Save to @color

> Ask the human "What is your favorite fruit?" Save to @fruit

> A paragraph long poem about @color and @fruit -> @poem

```js
success({ poem });
```
