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

```js
const topic = args[0] ?? fail('Pass a topic, e.g. --arg "WebAssembly component model"');
const results = await webSearch(topic);
```

> From @results pick up to 3 URLs of primary sources (official docs, specs, project blogs) over aggregators.
> Save the list of URLs to @urls

```js
assert(urls.length > 0, 'no usable sources found');
const chosen = urls.slice(0, 3);
for (const url of chosen) {
    assert(url.startsWith('https://'), `refusing non-HTTPS source ${url}`);
    assert(results.includes(url), `${url} was not in the search results`);
}

const pages = {};
await restrict({ net: chosen.map(url => new URL(url).hostname) }, async () => {
    for (const url of chosen) {
        try {
            pages[url] = (await webFetch(url)).slice(0, 20000);
        } catch (error) {
            if (!(error instanceof Failure)) throw error;
            log(`Skipping ${url}: ${error.reason}`);
        }
    }
});
const sources = Object.keys(pages);
assert(sources.length > 0, 'none of the sources could be fetched');
```

> @CTL(forbid='facts that are not supported by @pages')
>
> Write a digest about @topic: a 3-sentence overview, then up to 5 bullet points with key facts.
> End each bullet with its source URL in square brackets. Save the Markdown to @digest

```js
for (const line of digest.split('\n').map(line => line.trim())) {
    if (!line.startsWith('- ') && !line.startsWith('* ')) continue;
    const cited = line.slice(line.lastIndexOf('[') + 1).split(']')[0];
    assert(sources.includes(cited), `bullet cites ${cited}, which was not fetched: ${line}`);
}
success(digest);
```
