---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---


```spl 
import * as markdown from 'markdown'

let doc = markdown.Document()
doc.heading('Report', 1)
doc.paragraph(markdown.bold('Ready'))
success doc.to_string()
```
