---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Incident report from application logs

Parsing and counting are plain code, so the numbers in the report are exact. The model
only writes the narrative, from the extracted facts rather than the raw log.

    spl examples/incident-report.md --arg ./examples/data/app.log

```spl
let path = './examples/data/app.log'
if $args[0] != None:
    path = $args[0]
let counts = {'INFO': 0, 'WARN': 0, 'ERROR': 0}
let groups = {}
let first = None
let last = None
for line in read_file(path).splitlines():
    let parts = line.split()
    if len(parts) < 4:
        continue
    let level = parts[1]
    counts[level] = counts.get(level, 0) + 1
    if level != 'ERROR':
        continue
    let message = ' '.join(parts[3:]).split(' (')[0]
    let key = "{parts[2]}: {message}"
    if key not in groups:
        groups[key] = {'count': 0, 'first': parts[0]}
    groups[key].count += 1
    if first == None:
        first = parts[0]
    last = parts[0]
if counts.ERROR == 0:
    success 'No errors in {path}'
let errors = []
for item in items(groups):
    errors.append("{item[1].count}x {item[0]} (first at {item[1].first})")
```

> @FORBID speculating beyond what @errors and @counts show; mark guesses as hypotheses
>
> Write a blameless incident report in Markdown for errors between @first and @last.
> Use the sections "Summary", "Timeline", "Impact", "Likely root cause" and "Follow-ups",
> based on @errors and @counts. Save to @report

```spl
for section in ['Summary', 'Timeline', 'Impact', 'Likely root cause', 'Follow-ups']:
    assert section in report "report is missing the '{section}' section"
let day = first.split('T')[0]
restrict './reports':
    write_file('./reports/incident-{day}.md', report)
success {'errors': counts.ERROR, 'groups': len(errors), 'report': './reports/incident-{day}.md'}
```
