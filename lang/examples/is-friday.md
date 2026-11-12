---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

```js
const isFriday = await ask('Is today Friday? Return true or false.', { schema: bool });

if (isFriday) success('Today is Friday!');
success(await ask('Complain in original way'));
```
