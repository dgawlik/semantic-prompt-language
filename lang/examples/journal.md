---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Rolling journal

Remembers earlier runs through the variable store: top-level variables are saved on exit
and loaded again on the next run.

    spl examples/journal.md --store journal.json

```spl
def stored_runs() {
    try { return runs } except first_run { return 0 }
}
def stored_history() {
    try { return history } except first_run { return [] }
}
let runs = stored_runs() + 1
let history = stored_history()
let notes = read_file('./examples/data/notes.txt')
```

> Summarize @notes in one sentence and save it to @today

```spl
history.append({'run': runs, 'summary': today})
if len(history) > 5 {
    history = history[1:]
}
let trend = ''
```

> If @history has more than one entry, describe in one paragraph what changes from run to run
> and save it to @trend. Otherwise leave @trend unchanged.

```spl
success {'run': runs, 'today': today, 'trend': trend}
```