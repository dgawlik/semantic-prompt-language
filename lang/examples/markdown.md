---
extension: 'semantic-prompt-language'
version: 1
---

# Build Markdown without a model

The `markdown` builder is part of the library, so this workflow needs no model or login.

```js
const doc = markdown.document()
    .heading('Report', 1)
    .paragraph(markdown.bold('Ready'))
    .bulletList(['parser', 'runtime'].map(name => `${markdown.code(name)}: passed`))
    .table(['Check', 'Result'], [['build', 'ok'], ['tests', 'ok']]);

success(doc.toString());
```
