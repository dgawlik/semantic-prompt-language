---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Translate product docs without breaking them

Translates a Markdown announcement into several languages, then verifies deterministically
that links, e-mail addresses, code spans and the heading structure survived.
Target languages come from the arguments.

    spl examples/translate-docs.md --arg en --arg de --arg pl

```js
const source = await readFile('./examples/data/product-update.md');
const languages = args.length ? [...args] : ['en', 'de', 'pl'];

/** Code spans, URLs and e-mail addresses that a translation must keep verbatim. */
function protectedTokens(text) {
    const spans = text.match(/`[^`]+`/g) ?? [];
    const links = text.match(/https:\/\/[\w\-.~:/?#=&%+@]+|[\w\-.+]+@[\w\-.]+/g) ?? [];
    return [...spans, ...links.map(link => link.replace(/[.,;:!?]+$/, ''))];
}

const headings = text => text.split(/\r?\n/).filter(line => line.startsWith('#')).map(line => line.split(' ')[0].length);

const keep = protectedTokens(source);
```

> @CTL(enforce=[
>     'Keep the Markdown structure, URLs, e-mail addresses and `code spans` exactly as in the source',
>     "Use the product's informal, friendly tone and localize UI paths such as menu names"
> ])
>
> Translate @source into every language code in @languages.
> Save an object mapping each language code to its translated Markdown to @translations

```js
for (const language of languages) {
    const text = translations[language];
    assert(typeof text === 'string', `missing translation for '${language}'`);
    for (const token of keep) assert(text.includes(token), `${language}: lost ${token}`);
    assert(String(headings(text)) === String(headings(source)), `${language}: heading structure changed`);
}

await restrict('./out/translations', async () => {
    for (const language of languages) {
        await writeFile(`./out/translations/product-update.${language}.md`, translations[language]);
    }
});
success(languages);
```
