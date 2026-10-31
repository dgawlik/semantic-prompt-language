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

For noninteractive checkpoint/resume automation instead:

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