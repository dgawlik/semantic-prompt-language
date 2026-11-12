---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Incident report from application logs

Parsing and counting are plain code, so the numbers in the report are exact. The model
only writes the narrative, from the extracted facts rather than the raw log.

    spl examples/incident-report.md --arg ./examples/data/app.log

```js
const path = args[0] ?? './examples/data/app.log';
const counts = { INFO: 0, WARN: 0, ERROR: 0 };
const groups = new Map();
let first = null;
let last = null;

for (const line of (await readFile(path)).split(/\r?\n/)) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 4) continue;
    const [time, level, component] = parts;
    counts[level] = (counts[level] ?? 0) + 1;
    if (level !== 'ERROR') continue;
    const message = parts.slice(3).join(' ').split(' (')[0];
    const key = `${component}: ${message}`;
    const group = groups.get(key) ?? { count: 0, first: time };
    group.count += 1;
    groups.set(key, group);
    first ??= time;
    last = time;
}

if (counts.ERROR === 0) success(`No errors in ${path}`);
const errors = [...groups].map(([key, group]) => `${group.count}x ${key} (first at ${group.first})`);
```

> @CTL(forbid='speculating beyond what @errors and @counts show; mark guesses as hypotheses')
>
> Write a blameless incident report in Markdown for errors between @first and @last.
> Use the sections "Summary", "Timeline", "Impact", "Likely root cause" and "Follow-ups",
> based on @errors and @counts. Save to @report

```js
for (const section of ['Summary', 'Timeline', 'Impact', 'Likely root cause', 'Follow-ups']) {
    assert(report.includes(section), `report is missing the '${section}' section`);
}
const day = first.split('T')[0];
await restrict('./reports', () => writeFile(`./reports/incident-${day}.md`, report));
success({ errors: counts.ERROR, groups: errors.length, report: `./reports/incident-${day}.md` });
```
