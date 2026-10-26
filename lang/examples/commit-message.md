---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Conventional commit message for staged changes

Drafts a commit message from `git diff --cached`, checks it against the Conventional Commits
format, and commits only after a human accepts or edits it.

    git add -p
    spl examples/commit-message.md --checkpoint commit.jsonl

```spl
let diff = ''
let stat = ''
restrict exec 'git' {
    diff = shell('git diff --cached')
    stat = shell('git diff --cached --stat')
}
if diff.strip() == '' {
    fail 'Nothing is staged. Run git add first.'
}
let TYPES = ['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'chore']
```

> @FORBID mentioning changes that are not in @diff
>
> @ENFORCE Explain why the change was made, not only what changed
>
> Write a Conventional Commits message for @diff (files: @stat).
> First line is `type(scope): summary` with a type from @TYPES, imperative mood, no trailing period.
> Then a blank line and a body of at most 5 lines wrapped at 72 characters. Save to @message

```spl
def check(text) {
    let lines = text.strip().splitlines()
    let subject = lines[0]
    assert ': ' in subject "subject must look like type(scope): summary, got '{subject}'"
    let kind = subject.split(':')[0].split('(')[0].replace('!', '')
    assert kind in TYPES "unknown commit type '{kind}'"
    assert len(subject) <= 72 "subject is {len(subject)} characters, limit is 72"
    assert not subject.endswith('.') 'subject must not end with a period'
    if len(lines) > 1 {
        assert lines[1] == '' 'subject and body must be separated by a blank line'
    }
    return text.strip()
}
message = check(message)
```

> @HUMAN Show @message and ask the user to reply "ok" to accept it or paste a corrected message. Save the reply to @reply

```spl
let final = message
if reply.strip().lower() != 'ok' {
    final = check(reply)
}
restrict './.git', exec 'git' {
    write_file('./.git/SPL_COMMIT_MSG', final + '\n')
    shell('git commit -F .git/SPL_COMMIT_MSG')
}
success final
```
