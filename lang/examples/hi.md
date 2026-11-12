---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
preamble: 'Be concise.'
---

# Hello, SPL

Prose like this is commentary. Only `js` fences and blockquotes run, top to bottom, in one shared scope.
The library (`ask`, `struct`, `writeFile`, `markdown`, ...) is already imported in every fence.

```js
const Topic = enumOf('recursion', 'closures', 'regular expressions');
const topics = ['recursion', 'closures', 'regular expressions'];

const Card = struct('Card', {
    term: Topic,
    definition: str.annotate({ desc: 'One line about' }),
    description: str.annotate({ desc: 'A paragraph about' }),
});

const cards = await Promise.all(topics.map(topic =>
    ask(`A one-sentence flashcard about ${topic}`, { schema: Card, repairs: 1 })));
```

> Pick the item of @cards whose card a beginner would find hardest. Save that item to @hardest

```js
const doc = markdown.document()
    .heading(hardest.term, 3)
    .paragraph(markdown.bold(hardest.definition))
    .paragraph(hardest.description);

await writeFile('./out/hardest-card.md', doc.toString());
```
