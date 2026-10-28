---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Research digest with checked citations

Searches the web for a topic, reads the top results, and writes a short digest.
Page fetches are restricted to the hosts of the chosen results, and every citation must point
to a page that was actually fetched.

    spl examples/web-digest.md --arg "WebAssembly component model"

```spl
let topic = $args[0]
if topic == None:
    fail 'Pass a topic, e.g. --arg "WebAssembly component model"'
let results = web_search(topic)
```

> From @results pick up to 3 URLs of primary sources (official docs, specs, project blogs) over aggregators.
> Save the list of URLs to @urls

```spl
assert len(urls) > 0 'no usable sources found'
let hosts = []
for url in urls[:3]:
    assert url.startswith('https://') "refusing non-HTTPS source {url}"
    assert url in results "{url} was not in the search results"
    hosts.append(url.split('/')[2])
let pages = {}
restrict net hosts:
    for url in urls[:3]:
        try:
            pages[url] = web_fetch(url)[:20000]
        except unreachable:
            log("Skipping {url}: {unreachable.reason}")
assert len(pages) > 0 'none of the sources could be fetched'
let sources = keys(pages)
```

> @FORBID facts that are not supported by @pages
>
> Write a digest about @topic: a 3-sentence overview, then up to 5 bullet points with key facts.
> End each bullet with its source URL in square brackets. Save the Markdown to @digest

```spl
for line in digest.splitlines():
    if line.strip().startswith('- ') or line.strip().startswith('* '):
        let cited = line.split('[')[-1].split(']')[0]
        assert cited in sources "bullet cites {cited}, which was not fetched: {line}"
success digest
```
