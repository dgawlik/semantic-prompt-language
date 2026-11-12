---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Release notes from git history

Collects commits since the latest tag, writes user-facing notes and prepends them to
`CHANGELOG.md`. Pass the new version as the first argument.

    spl examples/release-notes.md --cwd path/to/project --arg 1.4.0

```js
const version = args[0] ?? fail('Pass the release version, e.g. --arg 1.4.0');
let range = 'HEAD';
let since = 'the first commit';

const commits = await restrict({ exec: 'git' }, async () => {
    try {
        since = (await shell('git describe --tags --abbrev=0')).trim();
        range = `${since}..HEAD`;
    } catch (error) {
        if (!(error instanceof Failure)) throw error;
        log('No tags yet, using the whole history');
    }
    return (await shell(`git log --no-merges --oneline ${range}`)).trim();
});

if (commits === '') success(`Nothing to release since ${since}`);
log(`${commits.split('\n').length} commit(s) since ${since}`);
```

> @CTL(
>     enforce='Write for users of the product: describe the impact, not the implementation',
>     forbid='inventing changes that are not in @commits, and listing internal refactors or CI tweaks'
> )
>
> Group @commits into the sections "Features", "Fixes" and "Other" (omit empty sections) and
> write Markdown release notes for @version. Start with the heading `## <version>`, use `###` for sections
> and one bullet per change. Save to @notes

```js
notes = notes.trim();
assert(notes.startsWith(`## ${version}`), `notes must start with '## ${version}'`);
assert(notes.split('\n').some(line => line.startsWith('### ')), 'notes have no sections');

let changelog = '# Changelog\n';
try {
    changelog = await readFile('./CHANGELOG.md');
} catch (error) {
    if (!(error instanceof Failure)) throw error;
    log('Creating CHANGELOG.md');
}
const [title, ...rest] = changelog.split('\n');
const body = [notes, rest.join('\n').trim()].filter(Boolean).join('\n\n');

await restrict('./CHANGELOG.md', () => writeFile('./CHANGELOG.md', `${title}\n\n${body}\n`));
success(notes);
```
