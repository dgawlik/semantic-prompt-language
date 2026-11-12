---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Human review

Drafts an announcement, asks a reviewer directly in the shell, then applies the feedback.
Supply `--human` to answer without prompting:

    spl examples/human-review.md
    spl examples/human-review.md --human "Make the wording clearer"

To record and automatically resume the same run:

    spl examples/human-review.md --trace run.jsonl
    spl examples/human-review.md --trace run.jsonl --human "Make the wording clearer"

Completed runs replay without prompts or side effects. Choose another JSONL file to restart.

```js
const changes = await readFile('./examples/data/product-update.md');
```

> Draft a two-sentence English release announcement for @changes and save it to @draft

```js
await restrict('./out', () => writeFile('./out/review-draft.txt', draft));
const feedback = await human(`Reply "ok" to accept this draft, or describe what to change:\n\n${draft}`);
let final = draft;
```

> If @feedback is not "ok", rewrite @draft applying @feedback and save it to @final

```js
await restrict('./out', () => writeFile('./out/announcement.txt', final));
success({ draft, feedback, final });
```
