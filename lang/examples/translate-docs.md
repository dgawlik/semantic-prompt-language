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

```spl
let source = read_file('./examples/data/product-update.md')
let languages = list($args)
if len(languages) == 0 {
    languages = ['en', 'de', 'pl']
}

let URL_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~:/?#=&%+@'

def link_in(word) {
    let start = word.find('https://')
    if start < 0 {
        start = word.find('@')
        while start > 0 and word[start - 1] in URL_CHARS {
            start -= 1
        }
    }
    let end = start
    while end < len(word) and word[end] in URL_CHARS {
        end += 1
    }
    let link = word[start:end]
    while len(link) > 0 and link[-1] in '.,;:!?' {
        link = link[:-1]
    }
    return link
}

def protected(text) {
    let found = []
    let parts = text.split('`')
    for i in range(1, len(parts), 2) {
        found.append('`' + parts[i] + '`')
    }
    for word in text.split() {
        if 'https://' in word or '@' in word {
            found.append(link_in(word))
        }
    }
    return found
}

def headings(text) {
    let levels = []
    for line in text.splitlines() {
        if line.startswith('#') {
            levels.append(len(line.split(' ')[0]))
        }
    }
    return levels
}

let keep = protected(source)
```

> @ENFORCE Keep the Markdown structure, URLs, e-mail addresses and `code spans` exactly as in the source
>
> @ENFORCE Use the product's informal, friendly tone and localize UI paths such as menu names
>
> Translate @source into every language code in @languages.
> Save a dict mapping each language code to its translated Markdown to @translations

```spl
for lang in languages {
    assert lang in translations "missing translation for '{lang}'"
    let text = translations[lang]
    for token in keep {
        assert token in text "{lang}: lost {token}"
    }
    assert headings(text) == headings(source) "{lang}: heading structure changed"
}

restrict './out/translations' {
    for lang in languages {
        write_file('./out/translations/product-update.{lang}.md', translations[lang])
    }
}
success languages
```
