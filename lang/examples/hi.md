---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
preamble: 'Be concise.'
---

# Hello, SPL

Prose like this is commentary. Only `spl` fences and blockquotes run, top to bottom, in one shared scope.

```spl
let topics = ['recursion', 'closures', 'regular expressions']
let Card = {
    'type': 'object',
    'properties': {'term': {'type': 'string'}, 'definition': {'type': 'string'}},
    'required': ['term', 'definition'],
    'additionalProperties': False,
}
let cards = []
for topic in topics {
    cards.append(ask(schema=Card, repairs=1) 'A one-sentence flashcard about {topic}')
}
```

> Pick the topic from @topics whose card in @cards a beginner would find hardest. Save it to @hardest

```spl
assert hardest in topics "unexpected topic '{hardest}'"
restrict './out' {
    write_file('./out/cards.json', json_stringify(cards, 2))
}
success {'cards': len(cards), 'hardest': hardest}
```