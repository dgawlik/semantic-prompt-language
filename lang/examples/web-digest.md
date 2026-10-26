---
extension: semantic-prompt-language
version: 1
---

```spl
# Summarize a web page with network access limited to a single host,
# and prove the sandbox holds by catching a blocked request.

restrict net 'news.ycombinator.com' {
    let page = web_fetch('https://news.ycombinator.com')
    let headlines = ask '''
From this HTML list the 10 top stories as a Markdown bullet list: "- title (domain)".
Reply with ONLY the list.
{page}'''

    let themes = ask(len='paragraph') 'What themes run through these headlines?\n{headlines}'

    try {
        web_fetch('https://example.org')
        fail 'the request to a second host should have been blocked'
    } except err {
        assert err.status_code == 'restriction_violation' "unexpected failure: {err.reason}"
        log("blocked as expected: {err.reason}")
    }
}

success "{headlines}\n\n{themes}"
```
