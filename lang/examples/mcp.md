---
extension: semantic-prompt-language
version: 1
---

```spl
# Configure a docs MCP server exposing search, then run:
# spl examples/mcp.md --mcp <your-mcp.json> --cwd <project>
# MCP servers are trusted services; scopes limit calls, not their internal I/O.

restrict mcp 'docs/search' {
    let summary = agent \
     'Use docs/search to find the documentation for this project and summarize it.'
    success summary
}
```
