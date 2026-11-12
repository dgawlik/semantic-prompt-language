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

```js
const previous = JSON.parse(await readFile('./journal.json'));
const runs = previous.runs + 1;
let history = previous.history;
const notes = await readFile('./examples/data/notes.txt');
```

> Summarize @notes in one sentence and save it to @today

```js
history.push({ run: runs, summary: today });
history = history.slice(-5);
let trend = '';
```

> If @history has more than one entry, describe in one paragraph what changes from run to run
> and save it to @trend. Otherwise leave @trend unchanged.

```js
await writeFile('./journal.json', JSON.stringify({ runs, history }));
success({ run: runs, today, trend });
```
