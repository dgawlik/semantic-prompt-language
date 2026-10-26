---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Answer questions from an MCP docs server

Needs an MCP configuration with a server named `docs` that exposes a `search` tool.
MCP tools are available only to agents; `restrict mcp` limits which ones they may call.

    spl examples/mcp.md --mcp mcp.json --arg "How do I configure authentication?"

```spl
let question = $args[0]
if question == None {
    question = 'How do I get started?'
}
let answer = ''
restrict mcp 'docs/search' {
    answer = agent '''
Use docs/search to answer: {question}
End with a line "Sources:" followed by the URLs of the pages you used.'''
}
assert 'Sources:' in answer 'the answer does not cite its sources'
```

> @FORBID adding facts that are not in @answer
>
> Rewrite @answer as at most five short bullet points followed by its sources and return it with @SUCCESS