---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Release notes from git history

Collects commits since the latest tag, writes user-facing notes and prepends them to
`CHANGELOG.md`. Pass the new version as the first argument.

    spl examples/release-notes.md --cwd path/to/project --arg 1.4.0

```spl
let version = $args[0]
if version == None {
    fail 'Pass the release version, e.g. --arg 1.4.0'
}

let range = 'HEAD'
let since = 'the first commit'
let commits = ''
restrict exec 'git' {
    try {
        let tag = shell('git describe --tags --abbrev=0').strip()
        range = '{tag}..HEAD'
        since = tag
    } except no_tag {
        log('No tags yet, using the whole history')
    }
    commits = shell('git log --no-merges --oneline {range}').strip()
}
if commits == '' {
    success 'Nothing to release since {since}'
}
log("{len(commits.splitlines())} commit(s) since {since}")
```

> @ENFORCE Write for users of the product: describe the impact, not the implementation
>
> @FORBID inventing changes that are not in @commits, and listing internal refactors or CI tweaks
>
> Group @commits into the sections "Features", "Fixes" and "Other" (omit empty sections) and
> write Markdown release notes for @version. Start with the heading `## <version>`, use `###` for sections
> and one bullet per change. Save to @notes

```spl
notes = notes.strip()
assert notes.startswith('## {version}') "notes must start with '## {version}'"
let sections = 0
for line in notes.splitlines() {
    if line.startswith('### ') {
        sections += 1
    }
}
assert sections > 0 'notes have no sections'

let changelog = '# Changelog\n'
try {
    changelog = read_file('./CHANGELOG.md')
} except missing {
    log('Creating CHANGELOG.md')
}
let lines = changelog.splitlines()
let body = notes
let rest = '\n'.join(lines[1:]).strip()
if rest != '' {
    body = '{notes}\n\n{rest}'
}
restrict './CHANGELOG.md' {
    write_file('./CHANGELOG.md', '{lines[0]}\n\n{body}\n')
}
success notes
```
