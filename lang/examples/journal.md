---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Rolling journal

Reads and writes its state explicitly in `journal.json`. Initialize the file once:

    echo '{"runs":0,"history":[]}' > journal.json
    spl examples/journal.md --trace journal-run-1.jsonl

Reuse that trace to resume or replay the same run; use a different trace for the next journal entry.

```spl
let previous = json_parse(read_file('./journal.json'))
let runs = previous.runs + 1
let history = previous.history
let notes = read_file('./examples/data/notes.txt')
```

> Summarize @notes in one sentence and save it to @today

```spl
history.append(object:
    'run': runs
    'summary': today
)
if len(history) > 5:
    history = history[1:]
let trend = ''
```

> If @history has more than one entry, describe in one paragraph what changes from run to run
> and save it to @trend. Otherwise leave @trend unchanged.

```spl
write_file('./journal.json', json_stringify(object:
    'runs': runs
    'history': history
))
success object:
    'run': runs
    'today': today
    'trend': trend
```