---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Fix failing tests

Runs the test suite and lets an agent repair the source code, for at most three rounds.
The test runs themselves never call a model. The agent is limited to the project folder,
`npm` and `git`. Leaving tests untouched is prompt guidance, so the final step double-checks it.

    spl examples/fix-failing-tests.md --cwd path/to/npm/project

```spl
let attempt = 0
let green = False

restrict '.', exec 'npm,git' {
    forbid 'editing, skipping or deleting tests, or weakening assertions' {
        while attempt < 3 and not green {
            attempt += 1
            try {
                shell('npm test')
                green = True
            } except err {
                log("Tests failing in round {attempt}")
                agent '''
The test run failed with this output:
{err.reason}

Find the bug in the source code, not the tests, and fix it with the file tools.
Describe the change in one sentence.'''
            }
        }
    }
}
assert green 'Tests are still failing after 3 rounds'

let changed = ''
restrict exec 'git' {
    changed = shell('git diff --stat')
}
```

> If @changed lists any test or spec file, @fail with the names of those files.
> Otherwise summarize @changed in one sentence and return @SUCCESS with that summary and the @attempt count
