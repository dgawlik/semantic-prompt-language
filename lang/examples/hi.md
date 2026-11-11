---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
preamble: 'Be concise.'
---

# Hello, SPL

Prose like this is commentary. Only `spl` fences and blockquotes run, top to bottom, in one shared scope.

```spl

enum Topic = 'recursion' | 'closures' | 'regular expressions'

let topics: list[Topic] = ['recursion', 'closures', 'regular expressions']

struct Card:
    term: Topic
    definition: str [desc = 'One line about']
    description: str [desc='A paragraph about']

let cards = topics.map(
            lambda topic: ask(schema=Card, repairs=1) 
                'A one-sentence flashcard about {topic}'
)
```

> Pick the item of @cards whose card a beginner would find hardest. Save that item to @hardest

```spl
import * as markdown from 'markdown'

let m = markdown.Document()

m.heading(hardest.term, 3)
m.paragraph(markdown.bold(hardest.definition))
m.paragraph(hardest.description)

write_file('./out/hardest-card.md', m.to_string())
```