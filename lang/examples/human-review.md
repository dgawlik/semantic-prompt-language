---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Human review

Drafts an announcement, pauses for a reviewer, then applies the feedback. `human` never reads
the terminal: the run exits with code 3 and a JSON question, and a later run supplies the answer.

    spl examples/human-review.md --checkpoint run.jsonl --silent
    spl examples/human-review.md --resume run.jsonl --answer-for REQUEST_ID --answer-file feedback.txt

```spl
let changes = read_file('./examples/data/product-update.md')
```

> Draft a two-sentence English release announcement for @changes and save it to @draft

```spl
restrict './out':
    write_file('./out/review-draft.txt', draft)
let feedback = human 'Reply "ok" to accept this draft, or describe what to change:\n\n{draft}'
let final = draft
```

> If @feedback is not "ok", rewrite @draft applying @feedback and save it to @final

```spl
restrict './out':
    write_file('./out/announcement.txt', final)
success {'draft': draft, 'feedback': feedback, 'final': final}
```