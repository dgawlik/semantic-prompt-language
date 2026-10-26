---
extension: semantic-prompt-language
version: 1
---

```spl
# Write a draft once, then exit with a question instead of reading terminal input.
# Start with --checkpoint run.jsonl; resume with --answer-for and --answer-file.

let draft = 'Release 1.0: faster search and clearer error messages.'
restrict './out' {
    write_file('./out/review-draft.txt', draft)
}

let feedback = human 'Review this draft and provide feedback:\n{draft}'
assert len(feedback.strip()) > 0 'feedback must not be blank'

restrict './out' {
    write_file('./out/review-feedback.txt', feedback)
}
success {'draft': draft, 'feedback': feedback}
```
